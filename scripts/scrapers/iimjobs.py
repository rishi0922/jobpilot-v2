"""
IIMJobs scraper.

The previous version targeted `.job-wrap, .jobListItem` cards on
`/jobs/search/?search_keyword=...`. Both the URL pattern and the card classes
have been rotated since that scraper was written. This rewrite:
  - Tries multiple search URL shapes (current + legacy) for resilience.
  - Uses stealth headers (matches `_common.new_stealth_context`).
  - Waits on networkidle, not just domcontentloaded — IIMJobs server-side
    renders the shell but the listings are hydrated client-side.
  - Walks a list of card selectors so the scraper keeps working when only
    half the class names change in a redesign.
  - Falls back to scanning all `<a href="/jobs/...">` anchors on the page
    if no card matched any selector, so we still get *something* back.
"""

import re
from datetime import datetime
from urllib.parse import quote

from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout

from ._common import (
    build_rich_description,
    collect_tag_texts,
    new_stealth_context,
    normalize_url,
    safe_attr,
    safe_text,
    try_link_selectors,
    try_selectors,
    looks_like_target_role,
)

BASE = "https://www.iimjobs.com"

# Several URL shapes have been live for the IIMJobs search page across the past
# year — we try them in order. The first one to actually return results wins.
def _search_urls(query: str) -> list[str]:
    q = quote(query)
    q_slug = query.replace(" ", "-").lower()
    return [
        f"{BASE}/search/{q_slug}-jobs",
        f"{BASE}/jobs?keyword={q}",
        f"{BASE}/jobs/search/?search_keyword={q}&experience=0to5",
        f"{BASE}/search?q={q}",
    ]


async def scrape_iimjobs(queries: list[str], credentials: dict) -> list[dict]:
    jobs: list[dict] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        )
        context = await new_stealth_context(browser)
        page = await context.new_page()

        if credentials.get("username") and credentials.get("password"):
            try:
                await page.goto(f"{BASE}/candidate/login", wait_until="domcontentloaded", timeout=20000)
                await page.wait_for_timeout(1500)
                # Multiple selector candidates for the email/password fields
                for sel in ['input[name="email"]', 'input[type="email"]', "#email"]:
                    el = await page.query_selector(sel)
                    if el:
                        await el.fill(credentials["username"])
                        break
                for sel in ['input[name="password"]', 'input[type="password"]', "#password"]:
                    el = await page.query_selector(sel)
                    if el:
                        await el.fill(credentials["password"])
                        break
                await page.click('button[type="submit"]')
                await page.wait_for_timeout(3000)
            except Exception as e:
                print(f"[iimjobs] Login failed: {e}")

        for query in queries:
            try:
                found_for_query = await _scrape_one_query(page, query)
                jobs.extend(found_for_query)
                print(f"[iimjobs] '{query}' → {len(found_for_query)} jobs")
            except Exception as e:
                print(f"[iimjobs] '{query}': {type(e).__name__}: {e}")

        await context.close()
        await browser.close()
    return jobs


async def _scrape_one_query(page, query: str) -> list[dict]:
    """Try each URL shape until one returns at least one job card."""
    for url in _search_urls(query):
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=25000)
            try:
                await page.wait_for_load_state("networkidle", timeout=8000)
            except PlaywrightTimeout:
                pass
            await page.wait_for_timeout(1500)

            found = await _extract_cards(page)
            if found:
                return found
        except PlaywrightTimeout:
            print(f"[iimjobs] timeout {url}")
        except Exception as e:
            print(f"[iimjobs] {url}: {type(e).__name__}: {e}")

    # Nothing matched any URL shape — return empty rather than raising
    return []


async def _extract_cards(page) -> list[dict]:
    # First try a list of card-level selectors. Each entry has shipped on
    # IIMJobs at some point in the last 12-18 months.
    card_selectors = [
        "div.job-wrap",
        ".jobListItem",
        ".sr-card",
        ".job-card",
        "li.searchListing",
        "article",
    ]
    cards = []
    for sel in card_selectors:
        cards = await page.query_selector_all(sel)
        if cards:
            break

    out: list[dict] = []
    if cards:
        for card in cards[:25]:
            try:
                title = await try_selectors(card, [
                    ".job-title a", "h2 a", "h3 a", "a.title",
                    "a.job-title", "a.sr-job-title",
                ])
                company = await try_selectors(card, [
                    ".company-name", ".company", ".sr-company-name", ".org-name",
                ])
                loc = await try_selectors(card, [
                    ".location", ".loc", ".sr-location",
                ])
                href = await try_link_selectors(card, [
                    ".job-title a", "h2 a", "h3 a", "a.title", "a[href*='/jobs/']",
                ])
                if not title or not href:
                    continue

                # IIMJobs surfaces experience, posted-date and functional area
                # on each card. Capturing them lets `lib/scoring.ts` score
                # against a richer description string.
                experience = await try_selectors(card, [
                    ".sr-exp", ".exp", ".experience", ".fl-exp",
                ])
                desc = await try_selectors(card, [
                    ".sr-desc", ".job-desc", ".description", ".desc-text",
                ])
                posted = await try_selectors(card, [
                    ".posted-date", ".date", ".sr-date", ".date-time",
                ])
                salary = await try_selectors(card, [
                    ".salary", ".sr-salary", ".comp", ".compensation",
                ])
                skills = ""
                for tags_root in ("ul.tags", "ul.fl-skills", ".skill-list", ".sr-tags"):
                    skills = await collect_tag_texts(card, tags_root, "li")
                    if skills:
                        break

                out.append({
                    "title":     title,
                    "company":   company,
                    "location":  loc or "India",
                    "salary":    salary or None,
                    "sourceUrl": normalize_url(BASE, href),
                    "description": build_rich_description(
                        desc, experience=experience, skills=skills, posted=posted
                    ),
                    "scrapedAt": datetime.utcnow().isoformat(),
                })
            except Exception:
                continue
        if out:
            return out

    # Generic anchor fallback: every job listing has a URL like /j/123/some-slug.
    # We pick those, take the anchor text as title (typically "Role at Company"),
    # and let main.py's `classify_role` do the relevance filtering.
    anchors = await page.query_selector_all("a[href*='/j/'], a[href*='/jobs/']")
    seen_hrefs: set[str] = set()
    for a in anchors[:60]:
        try:
            href = await a.get_attribute("href")
            text = (await a.inner_text() or "").strip()
            if not href or not text or href in seen_hrefs:
                continue
            seen_hrefs.add(href)
            # Title in fallback path often includes company; keep first line only
            line = text.splitlines()[0].strip()
            if not looks_like_target_role(line):
                continue
            out.append({
                "title":     line[:200],
                "company":   "",
                "location":  "India",
                "salary":    None,
                "sourceUrl": normalize_url(BASE, href),
                "scrapedAt": datetime.utcnow().isoformat(),
            })
        except Exception:
            continue
    return out
