"""
MNC career site scraper.

Many "MNC" target companies don't run their own careers UIs — they embed a
hosted board from Greenhouse, Lever, Workday, SmartRecruiters, or Taleo. CSS
scraping any of those UIs is fragile because:
  - The HTML is iframed (so the selectors on the parent page don't match).
  - Workday and Taleo gate the content behind a JS-driven session that's slow
    to settle.
  - Class names change on every redeploy.

This rewrite splits the company list in two:

  1. **API path** — companies whose hosted board is on Greenhouse/Lever/Ashby
     have a fast, structured JSON endpoint. We call it directly (no browser)
     and get clean, role-filtered results in milliseconds per company. This is
     the same approach `scrapers/ats.py` uses and it's far more reliable than
     HTML scraping.

  2. **HTML path** — for the rest, we still launch Chromium, but with stealth
     headers, networkidle waits, multi-selector fallback, and an anchor
     fallback that picks any link whose visible text matches a target role.

The list of companies and their preferred path is the only thing maintenance
should ever need to touch.
"""

import re
from datetime import datetime
from typing import Optional

import httpx
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout

from ._common import (
    REAL_BROWSER_HEADERS,
    REAL_UA,
    new_stealth_context,
    looks_like_target_role,
    normalize_url,
    try_link_selectors,
    try_selectors,
)

ROLE_KEYWORDS = (
    "product manager", "associate product manager", "apm",
    "project manager", "program manager", "business analyst",
    "product owner",
)


def _is_relevant(title: str) -> bool:
    t = (title or "").lower()
    return any(k in t for k in ROLE_KEYWORDS)


def _looks_indian(location: str) -> bool:
    if not location:
        # No location info → keep it; orchestrator-level filters can still drop it
        return True
    s = location.lower()
    markers = (
        "india", "bengaluru", "bangalore", "mumbai", "delhi", "ncr", "noida",
        "gurgaon", "gurugram", "hyderabad", "pune", "chennai", "kolkata",
        "ahmedabad", "kochi", "trivandrum", "jaipur", "remote",
    )
    return any(m in s for m in markers)


# ── API-path companies (Greenhouse / Lever / Ashby) ─────────────────────────
#
# Each entry: (display_name, vendor, slug)
# Vendor must be one of: greenhouse, lever, ashby.
#
# Note: there is some intentional overlap with `scrapers/ats.py`. That module
# is the broader "all good ATS-hosted companies" list. Here we list specifically
# the MNCs we want the MNC source to surface, so they show up in the MNC bucket
# of the dashboard's source-health view and not only under `ats:*`.
API_COMPANIES: list[tuple[str, str, str]] = [
    # Greenhouse — most common modern ATS for tech companies
    ("Razorpay",       "greenhouse", "razorpay"),
    ("PhonePe",        "greenhouse", "phonepe"),
    ("Flipkart",       "greenhouse", "flipkart"),
    ("Swiggy",         "greenhouse", "swiggy"),
    ("Meesho",         "greenhouse", "meesho"),
    ("CRED",           "greenhouse", "cred"),
    ("Groww",          "greenhouse", "groww"),
    ("Postman",        "greenhouse", "postman"),
    ("Zepto",          "greenhouse", "zepto"),
    ("Sprinklr",       "greenhouse", "sprinklr"),
    ("Atlassian",      "greenhouse", "atlassian"),
    ("Stripe",         "greenhouse", "stripe"),
    ("Airbnb",         "greenhouse", "airbnb"),
    # Lever
    ("Slice",          "lever",      "slice"),
    ("Khatabook",      "lever",      "khatabook"),
    ("Smallcase",      "lever",      "smallcase"),
    ("Upstox",         "lever",      "upstox"),
    ("Netflix",        "lever",      "netflix"),
    ("Spotify",        "lever",      "spotify"),
    # Ashby
    ("Linear",         "ashby",      "linear"),
    ("Ramp",           "ashby",      "ramp"),
    ("Vercel",         "ashby",      "vercel"),
]


# ── HTML-path companies (no friendly ATS API available) ────────────────────
#
# These companies use Workday, Taleo, custom internal portals, or just don't
# expose a clean JSON endpoint. We fall back to headless Chromium for them.
HTML_COMPANIES = [
    {
        "company": "TCS",
        "search_url": "https://ibegin.tcs.com/iBegin/jobs/search?keyword=product+manager",
        "title_sels":   [".jd-title", ".job-title", "h3"],
        "loc_sels":     [".location", ".job-location"],
        "link_sels":    ["a[href*='jobDetail']", "a"],
        "base":         "https://ibegin.tcs.com",
    },
    {
        "company": "Cognizant",
        "search_url": "https://careers.cognizant.com/global/en/search-results?keywords=product+manager&location=India",
        "title_sels":   [".job-title", "h2", "[data-ph-at-job-title-text]"],
        "loc_sels":     [".job-location", "[data-ph-at-job-location-text]"],
        "link_sels":    ["a.job-title-link", "a[data-ph-at-job-link]", "a"],
        "base":         "https://careers.cognizant.com",
    },
    {
        "company": "Accenture",
        "search_url": "https://www.accenture.com/in-en/careers/jobsearch?jk=product+manager&country=India",
        "title_sels":   [".cmp-teaser__title", "h3", ".job-title"],
        "loc_sels":     [".location-info", ".job-location"],
        "link_sels":    ["a.cmp-teaser__action-link", "a"],
        "base":         "https://www.accenture.com",
    },
    {
        "company": "Wipro",
        "search_url": "https://careers.wipro.com/careers-home/jobs?keywords=product+manager&location=India",
        "title_sels":   [".job-title", "h2.title", "h3"],
        "loc_sels":     [".job-location", ".location"],
        "link_sels":    ["a.job-title-link", "a"],
        "base":         "https://careers.wipro.com",
    },
    {
        "company": "LTIMindtree",
        "search_url": "https://www.ltimindtree.com/careers/job-search/?searchTerm=product+manager",
        "title_sels":   [".job-title", "h3", ".jobTitleLink"],
        "loc_sels":     [".location", ".jobLocation"],
        "link_sels":    ["a.jobTitleLink", "a"],
        "base":         "https://www.ltimindtree.com",
    },
    {
        "company": "HCLTech",
        "search_url": "https://www.hcltech.com/careers/search-jobs#q=product+manager&t=Jobs&sort=relevancy",
        "title_sels":   [".CoveoResultLink", "h3.title", "a.CoveoResultLink"],
        "loc_sels":     [".coveo-field-location", ".location"],
        "link_sels":    ["a.CoveoResultLink", "a"],
        "base":         "https://www.hcltech.com",
    },
    {
        "company": "Genpact",
        "search_url": "https://genpact.taleo.net/careersection/genpact_ex/jobsearch.ftl?lang=en&keyword=product+manager",
        "title_sels":   [".jobTitle", "td.titreCol a", "h3"],
        "loc_sels":     [".location", "td.itemCol"],
        "link_sels":    ["td.titreCol a", "a"],
        "base":         "https://genpact.taleo.net",
    },
    {
        "company": "Deloitte",
        "search_url": "https://apply.deloitte.com/careers/SearchJobs/product%20manager?listFilterMode=1&jobOffset=0",
        "title_sels":   [".opportunity-job-title", "h3", ".job-title"],
        "loc_sels":     [".opportunity-location", ".location"],
        "link_sels":    ["a.opportunity-title", "a"],
        "base":         "https://apply.deloitte.com",
    },
    {
        "company": "KPMG",
        "search_url": "https://jobs.kpmg.com/KPMG/search/?q=product+manager&locationsearch=India",
        "title_sels":   [".jobTitle-link", ".job-title", "h2", "a.jobTitle-link"],
        "loc_sels":     [".jobLocation", ".location"],
        "link_sels":    ["a.jobTitle-link", "a"],
        "base":         "https://jobs.kpmg.com",
    },
    {
        "company": "EY",
        "search_url": "https://careers.ey.com/ey/search/?q=product+manager&location=India",
        "title_sels":   [".jobTitle-link", ".job-title", "h3.title"],
        "loc_sels":     [".jobLocation", ".location"],
        "link_sels":    ["a.jobTitle-link", "a"],
        "base":         "https://careers.ey.com",
    },
    {
        "company": "Juspay",
        "search_url": "https://juspay.in/careers",
        "title_sels":   [".job-title", "h3", ".opening-title"],
        "loc_sels":     [".location"],
        "link_sels":    ["a[href*='careers']", "a"],
        "base":         "https://juspay.in",
    },
    {
        "company": "Uber",
        "search_url": "https://www.uber.com/in/en/careers/list/?query=product+manager&location=India",
        "title_sels":   ["[data-test='job-title']", "h3"],
        "loc_sels":     ["[data-test='job-location']", ".location"],
        "link_sels":    ["a[data-test='job-title-link']", "a"],
        "base":         "https://www.uber.com",
    },
    {
        "company": "Paytm",
        "search_url": "https://paytmjobs.com/jobs?q=product+manager",
        "title_sels":   [".job-title", "h2", "h3"],
        "loc_sels":     [".location"],
        "link_sels":    ["a"],
        "base":         "https://paytmjobs.com",
    },
    {
        "company": "MakeMyTrip",
        "search_url": "https://careers.makemytrip.com/jobs/?q=product+manager",
        "title_sels":   [".job-title", "h3"],
        "loc_sels":     [".job-location"],
        "link_sels":    ["a"],
        "base":         "https://careers.makemytrip.com",
    },
    {
        "company": "Amazon",
        "search_url": "https://amazon.jobs/en/search?base_query=product+manager&loc_query=India",
        "title_sels":   ["h3.job-title", ".job-title"],
        "loc_sels":     [".location-and-id .location", ".location"],
        "link_sels":    ["a.job-link", "a"],
        "base":         "https://amazon.jobs",
    },
]


# ── API path (Greenhouse / Lever / Ashby) ──────────────────────────────────

HTTP_TIMEOUT = 15.0

API_HEADERS = {
    **REAL_BROWSER_HEADERS,
    "User-Agent": REAL_UA,
    "Accept": "application/json",
}


async def _fetch_greenhouse(client: httpx.AsyncClient, name: str, slug: str) -> list[dict]:
    url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"
    try:
        r = await client.get(url, timeout=HTTP_TIMEOUT)
        if r.status_code != 200:
            return []
        data = r.json()
        out: list[dict] = []
        for j in data.get("jobs", []):
            title = j.get("title", "")
            location = ((j.get("location") or {}).get("name") or "")
            if not _is_relevant(title) or not _looks_indian(location):
                continue
            out.append({
                "title":       title,
                "company":     name,
                "location":    location or "India",
                "sourceUrl":   j.get("absolute_url", ""),
                "salary":      None,
                "description": _strip_html(j.get("content", "")),
                "postedAt":    j.get("updated_at"),
                "scrapedAt":   datetime.utcnow().isoformat(),
            })
        return out
    except Exception as e:
        print(f"[mnc:greenhouse:{name}] {type(e).__name__}: {e}")
        return []


async def _fetch_lever(client: httpx.AsyncClient, name: str, slug: str) -> list[dict]:
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    try:
        r = await client.get(url, timeout=HTTP_TIMEOUT)
        if r.status_code != 200:
            return []
        data = r.json()
        out: list[dict] = []
        for j in data:
            title = j.get("text", "")
            cats = j.get("categories") or {}
            location = cats.get("location", "") or ""
            if not _is_relevant(title) or not _looks_indian(location):
                continue
            out.append({
                "title":       title,
                "company":     name,
                "location":    location or "India",
                "sourceUrl":   j.get("hostedUrl") or j.get("applyUrl", ""),
                "salary":      None,
                "description": _strip_html(j.get("descriptionPlain") or j.get("description") or ""),
                "postedAt":    _ms_iso(j.get("createdAt")),
                "scrapedAt":   datetime.utcnow().isoformat(),
            })
        return out
    except Exception as e:
        print(f"[mnc:lever:{name}] {type(e).__name__}: {e}")
        return []


async def _fetch_ashby(client: httpx.AsyncClient, name: str, slug: str) -> list[dict]:
    url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true"
    try:
        r = await client.get(url, timeout=HTTP_TIMEOUT)
        if r.status_code != 200:
            return []
        data = r.json()
        out: list[dict] = []
        for j in data.get("jobs") or []:
            title = j.get("title", "")
            location = j.get("location", "") or ""
            if not _is_relevant(title) or not _looks_indian(location):
                continue
            out.append({
                "title":       title,
                "company":     name,
                "location":    location or "India",
                "sourceUrl":   j.get("jobUrl") or j.get("applyUrl", ""),
                "salary":      None,
                "description": _strip_html(j.get("descriptionHtml") or j.get("description") or ""),
                "postedAt":    j.get("publishedAt"),
                "scrapedAt":   datetime.utcnow().isoformat(),
            })
        return out
    except Exception as e:
        print(f"[mnc:ashby:{name}] {type(e).__name__}: {e}")
        return []


_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE  = re.compile(r"\s+")

def _strip_html(html: str) -> str:
    if not html:
        return ""
    t = _TAG_RE.sub(" ", html)
    t = t.replace("&nbsp;", " ").replace("&amp;", "&").replace("&#39;", "'")
    return _WS_RE.sub(" ", t).strip()[:4000]


def _ms_iso(ms: object) -> Optional[str]:
    if not ms:
        return None
    try:
        return datetime.utcfromtimestamp(int(ms) / 1000).isoformat()
    except Exception:
        return None


# ── HTML path ───────────────────────────────────────────────────────────────

async def _scrape_html_company(page, cfg: dict) -> list[dict]:
    out: list[dict] = []
    try:
        await page.goto(cfg["search_url"], wait_until="domcontentloaded", timeout=30000)
        try:
            await page.wait_for_load_state("networkidle", timeout=10000)
        except PlaywrightTimeout:
            pass
        await page.wait_for_timeout(1500)

        for _ in range(3):
            await page.evaluate("window.scrollBy(0, 700)")
            await page.wait_for_timeout(500)

        # Try a generic list of card containers before falling back to anchors
        card_selectors = [
            "li.job-item", ".job-card", "article", "tr.data-row",
            "li[class*='job']", "div[class*='JobCard']", "div[class*='job-item']",
        ]
        cards = []
        for sel in card_selectors:
            cards = await page.query_selector_all(sel)
            if cards:
                break

        if cards:
            for card in cards[:30]:
                try:
                    title = await try_selectors(card, cfg["title_sels"])
                    loc   = await try_selectors(card, cfg["loc_sels"])
                    href  = None
                    for sel in cfg["link_sels"]:
                        el = await card.query_selector(sel)
                        if el:
                            href = await el.get_attribute("href")
                            if href:
                                break
                    if not title or not href or not _is_relevant(title):
                        continue
                    if not _looks_indian(loc):
                        continue
                    out.append({
                        "title":     title,
                        "company":   cfg["company"],
                        "location":  loc or "India",
                        "sourceUrl": normalize_url(cfg["base"], href),
                        "salary":    None,
                        "scrapedAt": datetime.utcnow().isoformat(),
                    })
                except Exception:
                    continue

        # Anchor fallback — many career portals don't use clean card markup.
        if not out:
            anchors = await page.query_selector_all("a")
            seen: set[str] = set()
            for a in anchors[:300]:
                try:
                    href = await a.get_attribute("href")
                    text = (await a.inner_text() or "").strip()
                    if not href or not text or href in seen:
                        continue
                    seen.add(href)
                    line = text.splitlines()[0].strip()
                    if not _is_relevant(line):
                        continue
                    out.append({
                        "title":     line[:200],
                        "company":   cfg["company"],
                        "location":  "India",
                        "sourceUrl": normalize_url(cfg["base"], href),
                        "salary":    None,
                        "scrapedAt": datetime.utcnow().isoformat(),
                    })
                except Exception:
                    continue
    except PlaywrightTimeout:
        print(f"[mnc] Timeout: {cfg['company']}")
    except Exception as e:
        print(f"[mnc:{cfg['company']}] {type(e).__name__}: {e}")
    return out


async def scrape_mnc_sites() -> list[dict]:
    """Run API-path companies first (fast, reliable), then HTML-path
    companies (slow, browser-based)."""
    out: list[dict] = []

    # ── API path ──
    async with httpx.AsyncClient(headers=API_HEADERS) as client:
        for name, vendor, slug in API_COMPANIES:
            if vendor == "greenhouse":
                jobs = await _fetch_greenhouse(client, name, slug)
            elif vendor == "lever":
                jobs = await _fetch_lever(client, name, slug)
            elif vendor == "ashby":
                jobs = await _fetch_ashby(client, name, slug)
            else:
                jobs = []
            if jobs:
                print(f"[mnc:{vendor}:{name}] {len(jobs)} jobs")
            out.extend(jobs)

    # ── HTML path ──
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        )
        for cfg in HTML_COMPANIES:
            context = await new_stealth_context(browser)
            page = await context.new_page()
            try:
                jobs = await _scrape_html_company(page, cfg)
                if jobs:
                    print(f"[mnc:html:{cfg['company']}] {len(jobs)} jobs")
                out.extend(jobs)
            finally:
                await context.close()
        await browser.close()

    return out
