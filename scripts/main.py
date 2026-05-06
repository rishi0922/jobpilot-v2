"""
JobPilot Scraper Service
FastAPI + Playwright based scraper for Indian job boards.
Deploy on Render.com (free tier).
"""

from fastapi import FastAPI, HTTPException, Depends, Header, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import asyncio
import os
import httpx
from datetime import datetime

from scrapers.naukri import scrape_naukri
from scrapers.linkedin import scrape_linkedin
from scrapers.iimjobs import scrape_iimjobs
from scrapers.instahyre import scrape_instahyre
from scrapers.hirist import scrape_hirist
from scrapers.wellfound import scrape_wellfound
from scrapers.mnc import scrape_mnc_sites
from scrapers.ats import scrape_ats
from applicator import apply_to_job

app = FastAPI(title="JobPilot Scraper", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SCRAPER_API_KEY = os.environ.get("SCRAPER_API_KEY", "")
NEXT_APP_URL    = os.environ.get("NEXT_APP_URL", "http://localhost:3000")

SEARCH_QUERIES = [
    "associate product manager",
    "product manager",
    "project manager IT",
    "program manager IT",
    "business analyst IT",
]

ROLE_MAP = {
    "associate product manager": "APM",
    "apm": "APM",
    "product manager": "PM",
    "project manager": "PROJECT_MANAGER",
    "program manager": "PROGRAM_MANAGER",
    "business analyst": "BUSINESS_ANALYST",
    "ba ": "BUSINESS_ANALYST",
}

def classify_role(title: str) -> Optional[str]:
    """Map a job title to one of our role enums, or None if the title is
    NOT one of the roles we target. Returning None lets the caller drop
    irrelevant jobs (the whole reason for-the-search-keywords-matched-but-
    title-was-actually-irrelevant problem)."""
    t = f" {title.lower()} "
    if "associate product manager" in t or " apm " in t:
        return "APM"
    if "program manager" in t:
        return "PROGRAM_MANAGER"
    if "project manager" in t:
        return "PROJECT_MANAGER"
    if "business analyst" in t or " ba " in t:
        return "BUSINESS_ANALYST"
    if "product manager" in t or " pm " in t:
        return "PM"
    if "product owner" in t or " po " in t:
        return "PM"
    return None  # title doesn't match any of our target roles → drop the job


# Senior-level keywords we DON'T want for entry/mid roles
SENIOR_KEYWORDS = (
    "director", "vp", "vice president", "head of", "chief",
    "principal", "staff", "lead ", " lead", "sr.", "sr ",
    "senior", "snr", "group product", "gpm",
)

def is_relevant_job(title: str) -> bool:
    """Drop jobs that match a role keyword but are clearly too senior."""
    t = title.lower()
    return not any(kw in t for kw in SENIOR_KEYWORDS)

def verify_api_key(x_api_key: str = Header(...)):
    if x_api_key != SCRAPER_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return x_api_key

async def get_credentials(site: str) -> dict:
    """Fetch decrypted credentials from Next.js API. Returns {} on any failure
    so a missing/cold-started credential service doesn't kill the whole scrape."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.put(
                f"{NEXT_APP_URL}/api/credentials",
                json={"siteName": site},
                headers={"x-api-key": SCRAPER_API_KEY},
            )
            if r.status_code == 200:
                return r.json()
            print(f"[creds] {site}: HTTP {r.status_code}")
            return {}
    except Exception as e:
        print(f"[creds] {site}: {type(e).__name__}: {e}")
        return {}

async def save_jobs(jobs: list[dict], run_id: str):
    """Post scraped jobs back to Next.js API."""
    if not jobs:
        # Still notify so the run is marked complete even with 0 jobs
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                await client.post(
                    f"{NEXT_APP_URL}/api/scraper/ingest",
                    json={"jobs": [], "runId": run_id},
                    headers={"x-api-key": SCRAPER_API_KEY},
                )
        except Exception as e:
            print(f"[ingest] notify-empty failed: {type(e).__name__}: {e}")
        return
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                f"{NEXT_APP_URL}/api/scraper/ingest",
                json={"jobs": jobs, "runId": run_id},
                headers={"x-api-key": SCRAPER_API_KEY},
            )
            print(f"[ingest] sent {len(jobs)} jobs → HTTP {r.status_code}")
    except Exception as e:
        print(f"[ingest] failed: {type(e).__name__}: {e}")

@app.get("/health")
def health():
    return {"status": "ok", "time": datetime.utcnow().isoformat()}

class ScrapeRequest(BaseModel):
    sources: Optional[list[str]] = None
    runId:   Optional[str]       = None


async def _run_full_scrape(enabled: list[str], run_id: str):
    """Background worker that runs every enabled scraper SEQUENTIALLY (one site
    at a time) and posts results back. Sequential execution keeps memory under
    the 512MB Render free-tier limit — each Playwright Chromium instance can
    use 200-400MB on its own, so running 7 in parallel guarantees an OOM kill.

    We also flush jobs to the ingest endpoint after every site, so partial
    progress is preserved even if a later scraper crashes the container.
    """
    seen_urls: set[str] = set()
    total_saved = 0

    # Map source name -> a zero-arg async callable that returns its job list.
    # Wrapping in a callable lets us defer credential fetching and scraper
    # invocation until that source's turn — important because credential
    # fetches can also fail individually.
    async def _naukri():
        creds = await get_credentials("Naukri")
        return await scrape_naukri(SEARCH_QUERIES, creds)

    async def _linkedin():
        creds = await get_credentials("LinkedIn")
        return await scrape_linkedin(SEARCH_QUERIES, creds)

    async def _iimjobs():
        creds = await get_credentials("IIMJobs")
        return await scrape_iimjobs(SEARCH_QUERIES, creds)

    async def _instahyre():
        creds = await get_credentials("Instahyre")
        return await scrape_instahyre(SEARCH_QUERIES, creds)

    async def _hirist():
        return await scrape_hirist(SEARCH_QUERIES, {})

    async def _wellfound():
        return await scrape_wellfound(SEARCH_QUERIES, {})

    async def _mnc():
        return await scrape_mnc_sites()

    async def _ats():
        # Pure HTTP/JSON — no Playwright, no creds. ~50 companies in ~30-60s.
        return await scrape_ats()

    sources = {
        "ats":       _ats,        # ← new: Greenhouse/Lever/Ashby (most reliable)
        "naukri":    _naukri,
        "linkedin":  _linkedin,
        "iimjobs":   _iimjobs,
        "instahyre": _instahyre,
        "hirist":    _hirist,
        "wellfound": _wellfound,
        "mnc":       _mnc,
    }

    for name in enabled:
        runner = sources.get(name)
        if not runner:
            print(f"[scrape] unknown source: {name}")
            continue

        print(f"[scrape] starting {name}…")
        try:
            jobs = await runner()
        except Exception as e:
            print(f"[{name}] scrape error: {type(e).__name__}: {e}")
            continue

        unique = []
        dropped_irrelevant = 0
        dropped_senior     = 0
        for j in jobs or []:
            url = j.get("sourceUrl")
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)

            title = j.get("title", "")
            role  = classify_role(title)
            if role is None:
                dropped_irrelevant += 1
                continue
            if not is_relevant_job(title):
                dropped_senior += 1
                continue

            j["roleType"] = role
            # ATS scraper pre-tags each job with its specific vendor
            # (ats:greenhouse / ats:lever / ats:ashby) so source-health stats
            # show per-vendor breakdown. For all other scrapers, use the
            # configured runner key.
            if not j.get("source"):
                j["source"] = name
            unique.append(j)

        print(
            f"[{name}] scraped {len(jobs or [])} → kept {len(unique)} "
            f"(dropped {dropped_irrelevant} irrelevant, {dropped_senior} too-senior)"
        )

        # Flush after each source so partial progress survives container crashes.
        # ATS sub-sources mix multiple vendors in one batch; the ingest endpoint
        # currently keys per-source-stats off the FIRST job's source tag. Group
        # by tag and send each tag separately so per-vendor stats stay correct.
        if unique:
            by_tag: dict[str, list[dict]] = {}
            for j in unique:
                by_tag.setdefault(j["source"], []).append(j)
            for tag, batch in by_tag.items():
                await save_jobs(batch, run_id)
                total_saved += len(batch)

    # Final ping ensures the run is marked complete in the DB even if 0 jobs
    if total_saved == 0:
        await save_jobs([], run_id)

    print(f"[scrape] {run_id} complete — {total_saved} jobs from {len(enabled)} sources")


@app.post("/scrape", dependencies=[Depends(verify_api_key)], status_code=202)
async def run_scrape(payload: ScrapeRequest, background: BackgroundTasks):
    """
    Trigger a full scrape. Returns immediately (202) and runs the scrape in the
    background, posting results to NEXT_APP_URL/api/scraper/ingest when done.
    This pattern is required because the caller (Vercel serverless) cannot wait
    for a multi-minute scrape to complete.
    """
    enabled = payload.sources or [
        "naukri", "linkedin", "iimjobs", "instahyre", "hirist", "wellfound", "mnc"
    ]
    run_id = payload.runId or f"run_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"

    background.add_task(_run_full_scrape, enabled, run_id)

    return {
        "runId":     run_id,
        "sources":   enabled,
        "status":    "accepted",
        "timestamp": datetime.utcnow().isoformat(),
    }

@app.post("/apply", dependencies=[Depends(verify_api_key)])
async def apply_job(payload: dict):
    """Apply to a single job. Called by Next.js queue processor."""
    job_id       = payload.get("jobId")
    source_url   = payload.get("sourceUrl")
    source       = payload.get("source")
    role_type    = payload.get("roleType")
    cv_url       = payload.get("cvUrl")
    creds        = payload.get("credentials", {})

    if not all([job_id, source_url, cv_url]):
        raise HTTPException(status_code=400, detail="jobId, sourceUrl, cvUrl required")

    result = await apply_to_job(
        source=source,
        url=source_url,
        cv_url=cv_url,
        credentials=creds,
        role_type=role_type,
    )

    # Report result back
    async with httpx.AsyncClient() as client:
        await client.patch(
            f"{NEXT_APP_URL}/api/jobs",
            json={
                "id":     job_id,
                "status": "APPLIED" if result["success"] else "FAILED",
                "cvUsed": role_type,
            },
            headers={"x-api-key": SCRAPER_API_KEY},
            timeout=15,
        )

    return result
