"""
Wellfound (ex-AngelList) scraper.

Wellfound is aggressive about bot detection — they fingerprint Playwright via
the `navigator.webdriver` flag, missing Chrome client hints, and the absence
of typical mouse movement. The previous scraper used a stock Mac UA and a
plain `browser.new_context(...)`, which is why it consistently returned 0
jobs.

This rewrite:
  - Uses the stealth context from `_common` (real UA, sec-ch-ua headers,
    `navigator.webdriver` patch).
  - Tries a few URL shapes, including the role-slug page which doesn't need
    JS to render the listings list.
  - Waits networkidle then scrolls to trigger lazy-loaded cards.
  - Multi-selector card extraction with anchor fallback.
"""

import asyncio
from datetime import datetime
from urllib.parse import quote

from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout

from ._common import (
    LOW_MEM_CHROMIUM_ARGS,
    build_rich_description,
    collect_tag_texts,
    new_stealth_context,
    normalize_url,
    looks_like_target_role,
    try_link_selectors,
    try_selectors,
)

BASE = "https://wellfound.com"


def _search_urls(query: str) -> list[str]:
    """Wellfound is heavily bot-walled — historically returns 0 jobs from a
    headless Playwright session regardless of URL shape. We try only 2 URLs
    (instead of the previous 4) so a failing query costs ~30s instead of
    ~120s, freeing budget for MNC at the end of the run."""
    q = quote(query)
    slug = query.replace(" ", "-").lower()
    return [
        f"{BASE}/jobs?q={q}&country=IN",
        f"{BASE}/role/l/{slug}/india",
    ]


async def scrape_wellfound(queries: list[str], _credentials: dict) -> list[dict]:
    jobs: list[dict] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=LOW_MEM_CHROMIUM_ARGS)
        context = await new_stealth_context(browser)
        page = await context.new_page()

        for query in queries:
            # 45s per query — with 2-URL retry × ~20s each (15s goto + 3s
            # networkidle + 1.5s scroll), this is enough to fall through
            # cleanly when Wellfound's bot wall hides the listings.
            try:
                found = await asyncio.wait_for(
                    _scrape_one_query(page, query), timeout=45
                )
                jobs.extend(found)
                print(f"[wellfound] '{query}' → {len(found)} jobs")
            except asyncio.TimeoutError:
                print(f"[wellfound] '{query}' timed out after 45s")
            except Exception as e:
                print(f"[wellfound] '{query}': {type(e).__name__}: {e}")

        await context.close()
        await browser.close()
    return jobs


async def _scrape_one_query(page, query: str) -> list[dict]:
    for url in _search_urls(query):
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=15000)
            # Shorter networkidle wait — Wellfound's analytics polling never lets
            # networkidle fire, so this just always burns the full timeout. 3s
            # is enough for the initial XHR batch and saves 7s per URL.
            try:
                await page.wait_for_load_state("networkidle", timeout=3000)
            except PlaywrightTimeout:
                pass

            # Trigger lazy-loaded cards. Two scrolls is enough for the visible
            # viewport — the full results list is gated behind login anyway.
            for _ in range(2):
                await page.evaluate("window.scrollBy(0, 700)")
                await page.wait_for_timeout(500)

            found = await _extract_cards(page)
            if found:
                return found
        except PlaywrightTimeout:
            print(f"[wellfound] timeout {url}")
        except Exception as e:
            print(f"[wellfound] {url}: {type(e).__name__}: {e}")
    return []


async def _extract_cards(page) -> list[dict]:
    card_selectors = [
        "[data-test='JobListing']",
        ".styles_component__job",
        "[data-test='JobSearchResult']",
        ".job-listing",
        "div[class*='JobCard']",
        "div[class*='styles_jobListing']",
        "div[class*='styles_result']",
    ]
    cards = []
    for sel in card_selectors:
        cards = await page.query_selector_all(sel)
        if cards:
            break

    out: list[dict] = []
    if cards:
        for card in cards[:20]:
            try:
                title = await try_selectors(card, [
                    "[data-test='JobTitle']",
                    "h2", "h3", ".role-title", "a.title",
                ])
                company = await try_selectors(card, [
                    "[data-test='startup-name']",
                    ".company-name", ".startup-name",
                    "h3.styles_name", "[class*='startupTitle']",
                ])
                loc = await try_selectors(card, [
                    "[data-test='location']", ".location",
                    "[class*='location']",
                ])
                href = await try_link_selectors(card, [
                    "a[href*='/jobs/']", "a[href^='/jobs/']", "a",
                ])
                if not title or not href:
                    continue

                # Wellfound cards show compensation, an experience pill, and
                # a description preview. The skills/tech-stack chips live in
                # a sibling row on the parent — we capture what we can off the
                # job card itself (cards on Wellfound vary a lot between layouts).
                experience = await try_selectors(card, [
                    "[data-test='experience']", ".experience", "[class*='experience']",
                ])
                desc = await try_selectors(card, [
                    "[data-test='JobDescription']",
                    ".description", "[class*='description']", "p",
                ])
                salary = await try_selectors(card, [
                    "[data-test='compensation']", ".compensation",
                    "[class*='compensation']", "[class*='salary']",
                ])
                posted = await try_selectors(card, [
                    "[data-test='post-date']", ".posted", "[class*='postedDate']",
                ])
                skills = ""
                for tags_root in (
                    "[data-test='Tags']",
                    ".tags",
                    "[class*='styles_tags']",
                    "ul.skills",
                ):
                    skills = await collect_tag_texts(card, tags_root, "li")
                    if skills:
                        break
                if not skills:
                    for tags_root in ("[data-test='Tags']", "[class*='styles_tags']", ".tags"):
                        skills = await collect_tag_texts(card, tags_root, "span")
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

    # Anchor fallback: every Wellfound job lives at /jobs/<id>-<slug>.
    anchors = await page.query_selector_all("a[href*='/jobs/']")
    seen: set[str] = set()
    for a in anchors[:80]:
        try:
            href = await a.get_attribute("href")
            text = (await a.inner_text() or "").strip()
            if not href or not text or href in seen:
                continue
            # Filter out generic navigation links like /jobs (no slug)
            if href.rstrip("/").endswith("/jobs"):
                continue
            seen.add(href)
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
