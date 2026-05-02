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

def classify_role(title: str) -> str:
    t = title.lower()
    if "associate product" in t or "apm" in t:
        return "APM"
    if "program manager" in t:
        return "PROGRAM_MANAGER"
    if "project manager" in t:
        return "PROJECT_MANAGER"
    if "business analyst" in t or " ba " in t:
        return "BUSINESS_ANALYST"
    if "product manager" in t or " pm " in t:
        return "PM"
    return "PM"

def verify_api_key(x_api_key: str = Header(...)):
    if x_api_key != SCRAPER_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return x_api_key

async def get_credentials(site: str) -> dict:
    """Fetch decrypted credentials from Next.js API."""
    async with httpx.AsyncClient() as client:
        r = await client.put(
            f"{NEXT_APP_URL}/api/credentials",
            json={"siteName": site},
            headers={"x-api-key": SCRAPER_API_KEY},
            timeout=10,
        )
        if r.status_code == 200:
            return r.json()
        return {}

async def save_jobs(jobs: list[dict], run_id: str):
    """Post scraped jobs back to Next.js API."""
    if not jobs:
        return
    async with httpx.AsyncClient() as client:
        await client.post(
            f"{NEXT_APP_URL}/api/scraper/ingest",
            json={"jobs": jobs, "runId": run_id},
            headers={"x-api-key": SCRAPER_API_KEY},
            timeout=30,
        )

@app.get("/health")
def health():
    return {"status": "ok", "time": datetime.utcnow().isoformat()}

class ScrapeRequest(BaseModel):
    sources: Optional[list[str]] = None
    runId:   Optional[str]       = None


async def _run_full_scrape(enabled: list[str], run_id: str):
    """Background worker that runs every enabled scraper and posts results back."""
    all_jobs:   list[dict] = []
    seen_urls:  set[str]   = set()

    async def run_source(name: str, coro):
        try:
            jobs = await coro
            unique = [j for j in jobs if j.get("sourceUrl") not in seen_urls]
            for j in unique:
                seen_urls.add(j["sourceUrl"])
                j["roleType"] = classify_role(j.get("title", ""))
                j["source"]   = name
            return unique
        except Exception as e:
            print(f"[{name}] scrape error: {e}")
            return []

    tasks = []
    if "naukri" in enabled:
        creds = await get_credentials("Naukri")
        tasks.append(run_source("naukri", scrape_naukri(SEARCH_QUERIES, creds)))
    if "linkedin" in enabled:
        creds = await get_credentials("LinkedIn")
        tasks.append(run_source("linkedin", scrape_linkedin(SEARCH_QUERIES, creds)))
    if "iimjobs" in enabled:
        creds = await get_credentials("IIMJobs")
        tasks.append(run_source("iimjobs", scrape_iimjobs(SEARCH_QUERIES, creds)))
    if "instahyre" in enabled:
        creds = await get_credentials("Instahyre")
        tasks.append(run_source("instahyre", scrape_instahyre(SEARCH_QUERIES, creds)))
    if "hirist" in enabled:
        tasks.append(run_source("hirist", scrape_hirist(SEARCH_QUERIES, {})))
    if "wellfound" in enabled:
        tasks.append(run_source("wellfound", scrape_wellfound(SEARCH_QUERIES, {})))
    if "mnc" in enabled:
        tasks.append(run_source("mnc", scrape_mnc_sites()))

    try:
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for r in results:
            if isinstance(r, list):
                all_jobs.extend(r)
            else:
                print(f"[scrape] task error: {r}")
    except Exception as e:
        print(f"[scrape] gather failed: {e}")

    await save_jobs(all_jobs, run_id)
    print(f"[scrape] {run_id} complete — {len(all_jobs)} jobs from {len(enabled)} sources")


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
