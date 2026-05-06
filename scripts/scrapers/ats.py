"""
ATS-board scraper.

Hits the public JSON APIs of Greenhouse, Lever, and Ashby for ~50 hand-picked
Indian product companies. ATS APIs are stable, structured, and require no
browser — far more reliable than CSS-scraping Naukri/IIMJobs/etc.

Each company's careers page is hosted by exactly one of these vendors.
You can identify the vendor by visiting the company's "Careers" page and
inspecting the URL or page source for the brand. If a company changes ATS
vendors, just update the company's entry below.
"""

from datetime import datetime
from typing import Iterable, Optional

import httpx

# Per-request timeouts (seconds) — ATS APIs are usually fast (<2s)
HTTP_TIMEOUT = 15.0

# Curated list of Indian / India-friendly product companies (PM-heavy hiring)
# Format:
#   ("Display name", "vendor", "vendor-slug")
# Vendor must be one of: greenhouse, lever, ashby
GREENHOUSE_COMPANIES: list[tuple[str, str]] = [
    ("Razorpay",          "razorpay"),
    ("CRED",              "cred"),
    ("Meesho",            "meesho"),
    ("Groww",             "groww"),
    ("Spinny",            "spinny"),
    ("Postman",           "postman"),
    ("Zepto",             "zepto"),
    ("Atlassian",         "atlassian"),
    ("Stripe",            "stripe"),
    ("Airbnb",            "airbnb"),
    ("Coinbase",          "coinbase"),
    ("Robinhood",         "robinhood"),
    ("Notion",            "notion"),
    ("Figma",             "figma"),
    ("Pinterest",         "pinterest"),
    ("Reddit",            "reddit"),
    ("DoorDash",          "doordash"),
    ("Squarespace",       "squarespace"),
    ("Shopify",           "shopify"),
    ("Plaid",             "plaid"),
    ("Cloudflare",        "cloudflare"),
    ("Snowflake",         "snowflakecomputing"),
    ("Twilio",            "twilio"),
    ("Datadog",           "datadog"),
    ("Asana",             "asana"),
    ("Mixpanel",          "mixpanel"),
    ("Amplitude",         "amplitude"),
    ("Segment",           "segmentio"),
    ("Discord",           "discord"),
    ("Vimeo",             "vimeo"),
    ("Affirm",            "affirm"),
    ("Brex",              "brex"),
]

LEVER_COMPANIES: list[tuple[str, str]] = [
    ("Upstox",            "upstox"),
    ("Khatabook",         "khatabook"),
    ("Slice",             "slice"),
    ("Smallcase",         "smallcase"),
    ("Pixxel",            "pixxel"),
    ("InVideo",           "invideo"),
    ("Clari",             "clari"),
    ("Netflix",           "netflix"),
    ("Spotify",           "spotify"),
    ("Box",               "box"),
    ("KKR",               "kkr"),
    ("Github",            "github"),
    ("Palantir",          "palantir"),
]

ASHBY_COMPANIES: list[tuple[str, str]] = [
    ("Linear",            "linear"),
    ("Ramp",              "ramp"),
    ("Vercel",            "vercel"),
    ("Replit",            "replit"),
    ("Browserbase",       "browserbase"),
    ("Anthropic",         "anthropic"),
    ("OpenAI",            "openai"),
    ("ElevenLabs",        "elevenlabs"),
    ("Mercury",           "mercury"),
]


def _is_indian_or_remote(location: str) -> bool:
    """Return True if the location string mentions India or is fully remote.
    ATS feeds are global; we only want India-relevant postings."""
    if not location:
        return False
    s = location.lower()
    india_markers = (
        "india", "bengaluru", "bangalore", "mumbai", "delhi", "ncr", "noida",
        "gurgaon", "gurugram", "hyderabad", "pune", "chennai", "kolkata",
        "ahmedabad", "kochi", "trivandrum", "jaipur",
    )
    if any(m in s for m in india_markers):
        return True
    # Fully remote / "anywhere" jobs are also acceptable
    if "remote" in s and "us only" not in s and "americas only" not in s:
        return True
    return False


def _matches_target_role(title: str) -> bool:
    """Cheap pre-filter: only fetch full details for jobs whose titles look
    like our target roles. Avoids description fetches for obvious mismatches."""
    if not title:
        return False
    t = title.lower()
    keywords = (
        "product manager", "product mgr", "associate product",
        "project manager", "program manager", "business analyst",
        "product owner",
    )
    return any(kw in t for kw in keywords)


# ── Greenhouse ──────────────────────────────────────────────────────────────

async def _fetch_greenhouse(client: httpx.AsyncClient, slug: str) -> list[dict]:
    """Greenhouse public board API.
    Docs: https://developers.greenhouse.io/job-board.html
    Endpoint returns ALL jobs for a company in one call with full text."""
    url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"
    try:
        r = await client.get(url, timeout=HTTP_TIMEOUT)
        if r.status_code != 200:
            return []
        data = r.json()
        out = []
        for j in data.get("jobs", []):
            title    = j.get("title", "")
            location = (j.get("location") or {}).get("name", "") or ""
            if not _matches_target_role(title):
                continue
            if not _is_indian_or_remote(location):
                continue
            out.append({
                "title":       title,
                "company":     j.get("company_name") or slug.title(),
                "location":    location,
                "sourceUrl":   j.get("absolute_url", ""),
                "salary":      None,
                "description": _strip_html(j.get("content", "")),
                "postedAt":    j.get("updated_at"),
                "scrapedAt":   datetime.utcnow().isoformat(),
                "source":      "ats:greenhouse",  # vendor-specific tag for source-health stats
            })
        return out
    except Exception as e:
        print(f"[ats:greenhouse:{slug}] error: {type(e).__name__}: {e}")
        return []


# ── Lever ───────────────────────────────────────────────────────────────────

async def _fetch_lever(client: httpx.AsyncClient, slug: str) -> list[dict]:
    """Lever public postings API.
    Docs: https://github.com/lever/postings-api"""
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    try:
        r = await client.get(url, timeout=HTTP_TIMEOUT)
        if r.status_code != 200:
            return []
        data = r.json()
        out = []
        for j in data:
            title    = j.get("text", "")
            cats     = j.get("categories") or {}
            location = cats.get("location", "") or ""
            if not _matches_target_role(title):
                continue
            if not _is_indian_or_remote(location):
                continue
            out.append({
                "title":       title,
                "company":     slug.replace("-", " ").title(),
                "location":    location,
                "sourceUrl":   j.get("hostedUrl") or j.get("applyUrl", ""),
                "salary":      None,
                "description": _strip_html(j.get("descriptionPlain") or j.get("description") or ""),
                "postedAt":    None if not j.get("createdAt") else datetime.utcfromtimestamp(j["createdAt"] / 1000).isoformat(),
                "scrapedAt":   datetime.utcnow().isoformat(),
                "source":      "ats:lever",
            })
        return out
    except Exception as e:
        print(f"[ats:lever:{slug}] error: {type(e).__name__}: {e}")
        return []


# ── Ashby ───────────────────────────────────────────────────────────────────

async def _fetch_ashby(client: httpx.AsyncClient, slug: str) -> list[dict]:
    """Ashby public job posting API."""
    url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true"
    try:
        r = await client.get(url, timeout=HTTP_TIMEOUT)
        if r.status_code != 200:
            return []
        data = r.json()
        jobs = data.get("jobs") or []
        out = []
        for j in jobs:
            title    = j.get("title", "")
            location = j.get("location", "") or ""
            if not _matches_target_role(title):
                continue
            if not _is_indian_or_remote(location):
                continue
            out.append({
                "title":       title,
                "company":     j.get("organizationName") or slug.title(),
                "location":    location,
                "sourceUrl":   j.get("jobUrl") or j.get("applyUrl", ""),
                "salary":      None,
                "description": _strip_html(j.get("descriptionHtml") or j.get("description") or ""),
                "postedAt":    j.get("publishedAt"),
                "scrapedAt":   datetime.utcnow().isoformat(),
                "source":      "ats:ashby",
            })
        return out
    except Exception as e:
        print(f"[ats:ashby:{slug}] error: {type(e).__name__}: {e}")
        return []


# ── HTML utilities ──────────────────────────────────────────────────────────

import re

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE  = re.compile(r"\s+")

def _strip_html(html: str) -> str:
    """Best-effort HTML→text. ATS descriptions are short enough that a regex
    strip is fine — pulling in BeautifulSoup just for this is overkill."""
    if not html:
        return ""
    text = _TAG_RE.sub(" ", html)
    text = text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&#39;", "'")
    return _WS_RE.sub(" ", text).strip()[:4000]  # cap to keep DB rows reasonable


# ── Public entrypoint ───────────────────────────────────────────────────────

async def scrape_ats(_queries: Optional[list[str]] = None, _credentials: Optional[dict] = None) -> list[dict]:
    """Scrape every configured ATS company, sequentially. Each company is one
    HTTP call (no Playwright) so this is cheap and fast — running all ~50
    companies takes ~30-60 seconds total."""
    out: list[dict] = []
    async with httpx.AsyncClient(headers={"User-Agent": "JobPilot/1.0"}) as client:
        for name, slug in GREENHOUSE_COMPANIES:
            jobs = await _fetch_greenhouse(client, slug)
            if jobs:
                print(f"[ats:greenhouse:{name}] {len(jobs)} matching jobs")
            out.extend(jobs)
        for name, slug in LEVER_COMPANIES:
            jobs = await _fetch_lever(client, slug)
            if jobs:
                print(f"[ats:lever:{name}] {len(jobs)} matching jobs")
            out.extend(jobs)
        for name, slug in ASHBY_COMPANIES:
            jobs = await _fetch_ashby(client, slug)
            if jobs:
                print(f"[ats:ashby:{name}] {len(jobs)} matching jobs")
            out.extend(jobs)
    return out
