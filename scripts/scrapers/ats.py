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

import asyncio
from datetime import datetime
from typing import Iterable, Optional

import httpx

# ── Timeout / concurrency tuning ────────────────────────────────────────────
#
# ATS APIs are usually fast (<2s) but some hosts (we've seen Ashby, Lever's
# spotify, greenhouse's plaid) intermittently hang. The old code ran every
# company sequentially with a flat 15s timeout, so a handful of hung hosts
# could push a single ATS run past 10 minutes — exactly the kind of stall
# that eats the per-source budget in main.py.
#
# Fixes here:
#   - Split connect vs read timeouts so a dead host fails fast on connect.
#   - Run companies CONCURRENTLY with a bounded semaphore (so we don't open
#     60 sockets at once and trip rate limits or memory).
#   - Wrap each company fetch in asyncio.wait_for as a hard ceiling that
#     can't be exceeded no matter how the underlying client misbehaves.
#   - One quiet retry on timeout, since ATS hiccups are usually transient.
HTTP_TIMEOUT = httpx.Timeout(connect=5.0, read=12.0, write=5.0, pool=5.0)

# Hard per-company ceiling. Even with retry, a single company can never block
# the run for more than ~2× this. Kept comfortably under main.py's 240s
# per-source budget given the concurrency below.
PER_COMPANY_CEILING = 20.0

# Max simultaneous in-flight requests. 8 keeps us well under any sane rate
# limit while making a ~70-company sweep finish in well under a minute.
MAX_CONCURRENCY = 8

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
    # ── Expansion (Indian product cos + India-hiring globals on Greenhouse) ──
    ("PhonePe",           "phonepe"),
    ("Flipkart",          "flipkart"),
    ("Swiggy",            "swiggy"),
    ("Sprinklr",          "sprinklr"),
    ("Dream11",           "dreamsports"),
    ("MPL",               "mpl"),
    ("ShareChat",         "sharechat"),
    ("Chargebee",         "chargebee"),
    ("Whatfix",           "whatfix"),
    ("MoEngage",          "moengage"),
    ("Hasura",            "hasura"),
    ("Yellowai",          "yellowmessenger"),
    ("Innovaccer",        "innovaccer"),
    ("HackerRank",        "hackerrank"),
    ("Druva",             "druva"),
    ("Gupshup",           "gupshup"),
    ("Databricks",        "databricks"),
    ("MongoDB",           "mongodb"),
    ("Elastic",           "elastic"),
    ("GitLab",            "gitlab"),
    ("HubSpot",           "hubspot"),
    ("Airtable",          "airtable"),
    ("Rippling",          "rippling"),
    ("Wise",              "wise"),
    ("Grafana",           "grafanalabs"),
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
    # ── Expansion ──
    ("Jupiter",           "jupiter"),
    ("Rupeek",            "rupeek"),
    ("Cashfree",          "cashfree"),
    ("Plum",              "plumhq"),
    ("Hightouch",         "hightouch"),
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
    # ── Expansion ──
    ("Deel",              "deel"),
    ("Posthog",           "posthog"),
    ("Clipboard",         "clipboardhealth"),
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

async def _fetch_with_ceiling(
    fetch_fn,
    client: httpx.AsyncClient,
    vendor: str,
    name: str,
    slug: str,
) -> list[dict]:
    """Run one company fetch with a hard wall-clock ceiling and a single
    retry on timeout. Guarantees that no individual company can stall the
    overall sweep — whatever happens inside the httpx call, we abandon it
    after PER_COMPANY_CEILING seconds and move on.

    Returns [] on any failure (timeout, connect error, bad slug → 404).
    Never raises, so one bad company can't break asyncio.gather."""
    for attempt in (1, 2):
        try:
            return await asyncio.wait_for(
                fetch_fn(client, slug),
                timeout=PER_COMPANY_CEILING,
            )
        except asyncio.TimeoutError:
            if attempt == 1:
                # transient hiccup — quiet retry once
                continue
            print(f"[ats:{vendor}:{name}] ceiling timeout ({PER_COMPANY_CEILING}s) — skipping")
            return []
        except Exception as e:
            print(f"[ats:{vendor}:{name}] {type(e).__name__}: {e}")
            return []
    return []


async def scrape_ats(_queries: Optional[list[str]] = None, _credentials: Optional[dict] = None) -> list[dict]:
    """Scrape every configured ATS company CONCURRENTLY (bounded by a
    semaphore). Each company is one HTTP call (no Playwright), wrapped in a
    hard per-company ceiling so a hung host can't stall the run. With ~70
    companies at MAX_CONCURRENCY in-flight, a full sweep finishes in well
    under a minute even when several hosts are slow."""
    sem = asyncio.Semaphore(MAX_CONCURRENCY)

    # Build the work list: (vendor, name, slug, fetch_fn)
    work: list[tuple[str, str, str, object]] = []
    for name, slug in GREENHOUSE_COMPANIES:
        work.append(("greenhouse", name, slug, _fetch_greenhouse))
    for name, slug in LEVER_COMPANIES:
        work.append(("lever", name, slug, _fetch_lever))
    for name, slug in ASHBY_COMPANIES:
        work.append(("ashby", name, slug, _fetch_ashby))

    async with httpx.AsyncClient(headers={"User-Agent": "JobPilot/1.0"}) as client:
        async def _one(vendor: str, name: str, slug: str, fn) -> list[dict]:
            async with sem:  # bound concurrency
                jobs = await _fetch_with_ceiling(fn, client, vendor, name, slug)
                if jobs:
                    print(f"[ats:{vendor}:{name}] {len(jobs)} matching jobs")
                return jobs

        results = await asyncio.gather(
            *[_one(v, n, s, fn) for (v, n, s, fn) in work],
            return_exceptions=True,  # a stray raise never sinks the whole gather
        )

    out: list[dict] = []
    for r in results:
        if isinstance(r, list):
            out.extend(r)
        # exceptions already logged inside _fetch_with_ceiling; ignore here
    return out
