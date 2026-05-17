"""
Naukri.com scraper.

The previous implementation HTML-scraped `.srp-jobtuple-wrapper` cards in a
headless Chromium. Naukri ships selector changes almost monthly and aggressively
fingerprints Playwright, so that path returned 0 jobs more often than not.

This rewrite uses Naukri's own public mobile/web search JSON API as the primary
path. The endpoint is what `naukri.com/jobs-in-india` itself calls in the
background — it returns a stable, structured payload of job objects and only
needs two header tokens (`appid`, `systemid`) plus a realistic User-Agent. If
the API ever changes or starts rate-limiting our IP, we fall back to the older
HTML-scraping path so the source isn't a total blackout.

Endpoint reference (no official docs, observed from the production app):
    GET https://www.naukri.com/jobapi/v3/search
        ?keyword=<query>&pageNo=1&noOfResults=30
        &urlType=search_by_keyword&searchType=adv&experience=0&location=india
    Headers required: appid: 109, systemid: Naukri
"""

import re
from datetime import datetime
from typing import Optional
from urllib.parse import quote

import httpx
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout

from ._common import (
    REAL_BROWSER_HEADERS,
    REAL_UA,
    build_rich_description,
    collect_tag_texts,
    new_stealth_context,
    normalize_url,
    safe_attr,
    safe_text,
    try_link_selectors,
    try_selectors,
)

BASE_URL = "https://www.naukri.com"

# Headers needed to talk to the Naukri search JSON API. The `appid` and
# `systemid` tokens come from the production web bundle — they identify the
# request as coming from the desktop site rather than a third-party scraper.
API_HEADERS = {
    **REAL_BROWSER_HEADERS,
    "User-Agent": REAL_UA,
    "appid": "109",
    "systemid": "Naukri",
    "Referer": f"{BASE_URL}/",
    "Origin": BASE_URL,
    "clientid": "d3skt0p",
    "Accept": "application/json",
}


async def scrape_naukri(queries: list[str], credentials: dict) -> list[dict]:
    """Scrape Naukri for each query. Tries the JSON API first, then the HTML
    page as a fallback if the API path returns nothing for a given query."""
    jobs: list[dict] = []
    seen: set[str] = set()

    # ── JSON API path (preferred) ──────────────────────────────────────────
    async with httpx.AsyncClient(headers=API_HEADERS, timeout=30.0) as client:
        for query in queries:
            try:
                api_jobs = await _fetch_api(client, query)
                if not api_jobs:
                    print(f"[naukri] API returned 0 for '{query}' — will try HTML fallback")
                for j in api_jobs:
                    url = j.get("sourceUrl")
                    if not url or url in seen:
                        continue
                    seen.add(url)
                    jobs.append(j)
                print(f"[naukri] API '{query}' → {len(api_jobs)} jobs")
            except Exception as e:
                print(f"[naukri] API '{query}': {type(e).__name__}: {e}")

    # ── HTML fallback (used only for queries the API found nothing for) ────
    html_queries = [q for q in queries if not _query_present_in(jobs, q)]
    if html_queries:
        try:
            html_jobs = await _scrape_html(html_queries, credentials)
            for j in html_jobs:
                url = j.get("sourceUrl")
                if not url or url in seen:
                    continue
                seen.add(url)
                jobs.append(j)
            print(f"[naukri] HTML fallback contributed {len(html_jobs)} jobs across {len(html_queries)} queries")
        except Exception as e:
            print(f"[naukri] HTML fallback failed: {type(e).__name__}: {e}")

    return jobs


def _query_present_in(jobs: list[dict], query: str) -> bool:
    """Did the JSON API path already turn up at least one job whose title
    matches this query? Used to decide whether HTML fallback is worth the
    Playwright cost for that query."""
    q_tokens = [t for t in re.split(r"\s+", query.lower()) if t]
    if not q_tokens:
        return True
    for j in jobs:
        title = (j.get("title") or "").lower()
        if all(tok in title for tok in q_tokens):
            return True
    return False


async def _fetch_api(client: httpx.AsyncClient, query: str) -> list[dict]:
    """One page of search results via the JSON API."""
    params = {
        "noOfResults": 30,
        "urlType":     "search_by_keyword",
        "searchType":  "adv",
        "keyword":     query,
        "pageNo":      1,
        "experience":  "0",
        "location":    "india",
        "k":           query,
        "seoKey":      f"{query.replace(' ', '-')}-jobs",
    }
    r = await client.get(f"{BASE_URL}/jobapi/v3/search", params=params)
    if r.status_code != 200:
        print(f"[naukri] API HTTP {r.status_code} for '{query}'")
        return []
    try:
        data = r.json()
    except Exception as e:
        print(f"[naukri] API non-JSON response for '{query}': {e}")
        return []

    out: list[dict] = []
    for j in data.get("jobDetails", []) or []:
        title = (j.get("title") or "").strip()
        if not title:
            continue
        company = (j.get("companyName") or "").strip()

        # `placeholders` is Naukri's flat list of label/value pairs that
        # mixes location, salary, experience, etc. We pull only what we need.
        placeholders = j.get("placeholders") or []
        location = _placeholder(placeholders, "location") or "India"
        salary   = _placeholder(placeholders, "salary")
        exp      = _placeholder(placeholders, "experience")

        href = j.get("jdURL") or j.get("staticUrl") or ""
        if not href:
            continue
        url = href if href.startswith("http") else f"{BASE_URL}{href}"
        url = url.split("?")[0]  # drop tracking suffix

        # `createdDate` is a millis-epoch on the API. Convert to ISO.
        posted_at = _ms_epoch_to_iso(j.get("createdDate"))

        out.append({
            "title":       title,
            "company":     company,
            "location":    location,
            "salary":      salary,
            "sourceUrl":   url,
            "description": (j.get("jobDescription") or "").strip() or None,
            "postedAt":    posted_at,
            "scrapedAt":   datetime.utcnow().isoformat(),
            # Useful for debugging but the orchestrator overwrites "source"
            # before ingest, so the value here is informational only.
            "experience":  exp,
        })
    return out


def _placeholder(items: list[dict], kind: str) -> Optional[str]:
    """Read one labelled value out of a Naukri placeholders array."""
    for it in items:
        if it.get("type") == kind:
            val = (it.get("label") or "").strip()
            if val:
                return val
    return None


def _ms_epoch_to_iso(ms: object) -> Optional[str]:
    """Naukri timestamps are millis-since-epoch. Convert to ISO; return None
    on anything weird so the ingest endpoint sees a clean null."""
    if not ms:
        return None
    try:
        return datetime.utcfromtimestamp(int(ms) / 1000).isoformat()
    except Exception:
        return None


# ── HTML fallback ───────────────────────────────────────────────────────────
#
# URL shape + selector set are adapted from somranal2799/naukri-job-scraper-dashboard,
# a Selenium-based public Naukri scraper. We port the patterns into Playwright
# rather than introducing Selenium (which would mean a second headless browser
# stack on the Render free tier — memory we can't spare).
#
# Key things adopted from that repo:
#   - SEO URL with numeric pagination: /{role-slug}-jobs-in-{location}-{offset}.
#     Naukri serves these to crawlers without auth and they paginate cleanly.
#   - A richer selector set: span.expwdth, span.job-desc, span.job-post-day,
#     ul.tags-gt li, a.comp-name — these capture experience, description,
#     posted date, and skills, all of which feed the match-score calculation.
#   - Page-level wait keyed off the card selector instead of a fixed sleep.
#
# We keep the older query-param URL (?experience=0,5&location=india) as a
# secondary shape in case Naukri serves a different layout to that endpoint.

# 3 pages × 20 jobs per query is the same volume the upstream repo collects.
HTML_PAGES_PER_QUERY = 3
HTML_RESULTS_PER_PAGE = 20

# Locations to iterate when the orchestrator hasn't given us one. "india" matches
# the upstream repo's default and works as a country-wide SEO landing page.
DEFAULT_LOCATIONS = ["india"]


def _html_search_urls(query: str) -> list[str]:
    """Build the list of paginated URLs we should crawl for a query.

    Order matters: the SEO `/{slug}-jobs-in-{loc}-{offset}` shape comes first
    because that's the one that consistently renders the `.srp-jobtuple-wrapper`
    card markup. We then add a query-param URL as a fallback in case Naukri
    A/B-tests a different layout for that path.
    """
    slug = query.replace(" ", "-").lower()
    urls: list[str] = []
    for loc in DEFAULT_LOCATIONS:
        for page in range(HTML_PAGES_PER_QUERY):
            offset = page * HTML_RESULTS_PER_PAGE
            urls.append(f"{BASE_URL}/{slug}-jobs-in-{loc}-{offset}")
    # One fallback URL with the legacy query-param style
    urls.append(f"{BASE_URL}/{slug}-jobs?experience=0,5&location=india")
    return urls


async def _scrape_html(queries: list[str], credentials: dict) -> list[dict]:
    """Playwright fallback. Stealth context + paginated SEO URLs + multi-selector
    card extraction. URL pattern and selectors adapted from the upstream repo
    we were pointed at; we use Playwright instead of Selenium so we don't have
    to add a second browser stack to the Render deploy."""
    jobs: list[dict] = []
    seen: set[str] = set()
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        )
        context = await new_stealth_context(browser)
        page = await context.new_page()

        if credentials.get("username") and credentials.get("password"):
            await _login(page, credentials)

        for query in queries:
            kept_for_query = 0
            for url in _html_search_urls(query):
                try:
                    await page.goto(url, wait_until="domcontentloaded", timeout=30000)

                    # Prefer waiting on the card selector itself (upstream pattern)
                    # over networkidle — Naukri sometimes streams analytics XHRs
                    # after listings render, which would block networkidle forever.
                    try:
                        await page.wait_for_selector(
                            "article.jobTuple, div.srp-jobtuple-wrapper",
                            timeout=10000,
                        )
                    except PlaywrightTimeout:
                        # Fall back to a short networkidle then continue —
                        # the page may have rendered with a different layout.
                        try:
                            await page.wait_for_load_state("networkidle", timeout=5000)
                        except PlaywrightTimeout:
                            pass

                    cards = await page.query_selector_all(
                        "div.srp-jobtuple-wrapper, article.jobTuple, .jobTuple"
                    )
                    page_count = 0
                    if cards:
                        for card in cards[:HTML_RESULTS_PER_PAGE]:
                            row = await _parse_card(card)
                            if not row:
                                continue
                            if row["sourceUrl"] in seen:
                                continue
                            seen.add(row["sourceUrl"])
                            jobs.append(row)
                            page_count += 1

                    if page_count == 0:
                        # Last-resort generic anchor scrape: every job listing has
                        # a link to /job-listings/... — pick those titles directly.
                        anchors = await page.query_selector_all("a[href*='/job-listings/']")
                        for a in anchors[:25]:
                            try:
                                href = await a.get_attribute("href")
                                text = (await a.inner_text() or "").strip()
                                if not href or not text:
                                    continue
                                full = normalize_url(BASE_URL, href)
                                if full in seen:
                                    continue
                                seen.add(full)
                                jobs.append({
                                    "title":     text.splitlines()[0][:200],
                                    "company":   "",
                                    "location":  "India",
                                    "salary":    None,
                                    "sourceUrl": full,
                                    "scrapedAt": datetime.utcnow().isoformat(),
                                })
                                page_count += 1
                            except Exception:
                                continue

                    kept_for_query += page_count
                    # If a page returned nothing, no point paginating further
                    # for the same query — that's the upstream repo's behaviour.
                    if page_count == 0:
                        break

                except PlaywrightTimeout:
                    print(f"[naukri] HTML timeout for '{query}' @ {url}")
                except Exception as e:
                    print(f"[naukri] HTML error for '{query}' @ {url}: {type(e).__name__}: {e}")
            print(f"[naukri] HTML '{query}' → {kept_for_query} jobs across {HTML_PAGES_PER_QUERY} pages")

        await context.close()
        await browser.close()
    return jobs


async def _parse_card(card) -> Optional[dict]:
    """Pull title / company / location / salary / experience / description /
    posted / skills out of a single Naukri job card. Selector list is the
    union of what we had before plus what the upstream repo uses, so the
    parser keeps working when only some classes are renamed in a redesign."""
    try:
        title = await try_selectors(card, [
            "a.title", ".title", ".jobTitle", "a.jobTitle", "h2 a",
        ])
        href = await try_link_selectors(card, [
            "a.title", "a.jobTitle", "a[href*='/job-listings/']", "a",
        ])
        if not title or not href:
            return None

        company = await try_selectors(card, [
            "a.comp-name",  # upstream selector — distinct from ".comp-name" which
                           # the previous scraper used and which doesn't always match
            ".comp-name", ".companyInfo a", ".subTitle", ".company-name",
        ])
        loc = await try_selectors(card, [
            "span.locWdth", ".locWdth", ".location", ".loc", ".job-location",
        ])
        salary = await try_selectors(card, [
            ".salary", ".sal", ".salaryAndExp .salary", "span.sal",
        ])
        experience = await try_selectors(card, [
            "span.expwdth", ".expwdth", ".exp", ".experience",
        ])
        desc = await try_selectors(card, [
            "span.job-desc", ".job-desc", ".job-description",
        ])
        posted = await try_selectors(card, [
            "span.job-post-day", ".job-post-day", ".date", ".posted",
        ])

        # Skills tags. Naukri uses `ul.tags-gt` for the per-card skill chips.
        skills_text = await collect_tag_texts(card, "ul.tags-gt", "li")

        return {
            "title":       title,
            "company":     company,
            "location":    loc or "India",
            "salary":      salary or None,
            "sourceUrl":   normalize_url(BASE_URL, href),
            "description": build_rich_description(
                desc, experience=experience, skills=skills_text, posted=posted
            ),
            "postedAt":    None,  # text like "1 day ago" — leave None rather than try to parse
            "scrapedAt":   datetime.utcnow().isoformat(),
            "experience":  experience or None,
        }
    except Exception:
        return None


async def _login(page, creds: dict):
    try:
        await page.goto(f"{BASE_URL}/nlogin/login", wait_until="domcontentloaded", timeout=20000)
        await page.wait_for_timeout(1500)
        # Naukri has shipped at least three login form layouts over the past
        # year; try each placeholder in turn.
        for sel in [
            'input[placeholder*="Enter your active Email ID"]',
            'input[placeholder*="Email"]',
            'input[type="email"]',
            "#usernameField",
        ]:
            el = await page.query_selector(sel)
            if el:
                await el.fill(creds["username"])
                break
        for sel in [
            'input[placeholder*="Enter your password"]',
            'input[type="password"]',
            "#passwordField",
        ]:
            el = await page.query_selector(sel)
            if el:
                await el.fill(creds["password"])
                break
        await page.click('button[type="submit"]')
        await page.wait_for_timeout(3000)
    except Exception as e:
        print(f"[naukri] Login failed: {e}")
