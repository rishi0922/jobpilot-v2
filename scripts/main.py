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
import sys
import httpx
from datetime import datetime

# Force line-buffered stdout/stderr so per-scraper print() output appears in
# Render logs in real time. Without this, Python buffers prints in 4 KB blocks
# under non-TTY (Docker/Render) and the user can't see what's happening in a
# multi-minute background scrape until the process exits. Setting
# PYTHONUNBUFFERED=1 in the Render env var does the same thing, but doing it
# in code makes the deploy self-contained.
try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except Exception:
    pass

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

async def _keepalive_loop():
    """Render's free-tier web service spins down after 15 minutes of no
    incoming HTTP traffic — even if Python is actively running in the
    background. A full scrape takes ~25-30 minutes, well past that
    threshold, so without this we get killed mid-IIMJobs every time.

    Workaround: from inside the scrape, hit our own /health endpoint every
    60 s. Render counts that as activity and keeps the service alive.

    Cancelled by `_run_full_scrape` once the scrape finishes. Any errors
    are swallowed — if the keepalive itself crashes the scrape should
    still proceed (just risks the 15-min sleep again)."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            while True:
                await asyncio.sleep(60)
                try:
                    await client.get("http://localhost:10000/health")
                except Exception:
                    pass  # don't surface — keepalive failures are best-effort
    except asyncio.CancelledError:
        pass  # normal shutdown when scrape completes


async def fetch_known_urls() -> set[str]:
    """Pull the set of sourceUrls already stored in the DB so we can skip them
    before doing the expensive parse/score/upsert work. Returns an empty set
    on any failure — a missed dedup is just wasted work, not a correctness
    bug (DB-level @unique constraint is still the source of truth)."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(
                f"{NEXT_APP_URL}/api/scraper/known-urls",
                headers={"x-api-key": SCRAPER_API_KEY},
            )
            if r.status_code != 200:
                print(f"[known-urls] HTTP {r.status_code} — proceeding without dedup seed")
                return set()
            data = r.json()
            urls = set(data.get("urls", []))
            print(f"[known-urls] seeded {len(urls)} already-scraped URLs")
            return urls
    except Exception as e:
        print(f"[known-urls] {type(e).__name__}: {e} — proceeding without dedup seed")
        return set()


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
    # Spawn the self-keepalive task so Render's 15-min idle timer never fires
    # while a scrape is in progress. Cancelled at the end of this function.
    keepalive_task = asyncio.create_task(_keepalive_loop())

    # Seed the in-memory dedup set with URLs already in the DB. Cards whose URL
    # is in this set will be dropped before we run quality-gate / scoring /
    # upsert — saving the wasted work of re-processing the same job every run.
    seen_urls: set[str] = await fetch_known_urls()
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
            # Per-source hard timeout. Without this, one broken/hanging scraper
            # (e.g. an Instahyre query that never resolves) blocks every
            # scraper queued after it — that's why we historically saw
            # hirist/wellfound/mnc never running. 7 min per source covers
            # 5 queries × ~80s each (4 URL shapes × ~25s goto + render time)
            # with headroom for the login attempt and the closing teardown.
            jobs = await asyncio.wait_for(runner(), timeout=420)
        except asyncio.TimeoutError:
            print(f"[{name}] timed out after 420s — moving on")
            continue
        except Exception as e:
            print(f"[{name}] scrape error: {type(e).__name__}: {e}")
            continue

        # Force GC between sources so each fresh Playwright Chromium doesn't
        # stack on top of memory the previous browser leaked. Render free
        # tier has only 512 MB total — easy to OOM-kill otherwise.
        import gc
        gc.collect()

        unique = []
        dropped_irrelevant = 0
        dropped_senior     = 0
        dropped_known      = 0  # already in DB or already seen in this run
        for j in jobs or []:
            url = j.get("sourceUrl")
            if not url:
                continue
            if url in seen_urls:
                dropped_known += 1
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
            f"[{name}] scraped {len(jobs or [])} → kept {len(unique)} new "
            f"(dropped {dropped_known} already-known, {dropped_irrelevant} irrelevant, "
            f"{dropped_senior} too-senior)"
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

    # Cancel the keepalive — scrape is done, Render can sleep now.
    keepalive_task.cancel()
    try:
        await keepalive_task
    except (asyncio.CancelledError, Exception):
        pass

    print(f"[scrape] {run_id} complete — {total_saved} jobs from {len(enabled)} sources")


@app.post("/scrape", dependencies=[Depends(verify_api_key)], status_code=202)
async def run_scrape(payload: ScrapeRequest, background: BackgroundTasks):
    """
    Trigger a full scrape. Returns immediately (202) and runs the scrape in the
    background, posting results to NEXT_APP_URL/api/scraper/ingest when done.
    This pattern is required because the caller (Vercel serverless) cannot wait
    for a multi-minute scrape to complete.
    """
    # Order matters on Render's 512 MB free tier — Chromium leaks ~150 MB per
    # browser launch even after `await browser.close()` (the OS doesn't fully
    # reclaim mapped pages until the process exits). Running 7 Playwright
    # scrapers in sequence eventually OOMs the container mid-run.
    #
    # Mitigations:
    #   1. HTTP-only sources (ats, mnc-API path) run FIRST so we always capture
    #      their jobs before any OOM risk.
    #   2. Highest-yield Playwright sources (hirist, iimjobs) come next so if
    #      we crash later, the most valuable jobs are already saved.
    #   3. Low-yield/broken sources (naukri, instahyre, wellfound) go LAST so
    #      an OOM there costs us the least.
    #
    # Naukri is excluded from defaults entirely because it now consistently
    # returns 0 jobs (server-side bot wall + API 404) and burns a Chromium
    # launch that we can't afford. Callers can still pass sources=['naukri']
    # explicitly if they want to retry.
    enabled = payload.sources or [
        "ats", "mnc", "hirist", "iimjobs", "linkedin", "wellfound", "instahyre"
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
