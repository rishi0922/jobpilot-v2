"""
Instahyre scraper.

Instahyre is a React SPA — the previous scraper waited on `domcontentloaded`
and queried `.opportunity-info, .job-card` immediately, which is why it
returned 0 results: those classes don't exist until the React tree mounts and
the listings XHR resolves.

This rewrite:
  - Uses stealth headers.
  - Waits for the listings XHR to finish via networkidle, then scrolls a
    couple of times to trigger lazy-load.
  - Tries multiple search URL shapes.
  - Walks a list of card selectors and a generic anchor fallback.

Instahyre's `/api/v1/jobs/` endpoint is gated behind a session cookie, so we
don't hit the API directly — the HTML path with proper waits is good enough.
"""

import asyncio
from datetime import datetime
from urllib.parse import quote

from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout

from ._common import (
    LOW_MEM_CHROMIUM_ARGS,
    _safe_login,
    build_rich_description,
    collect_tag_texts,
    new_stealth_context,
    normalize_url,
    looks_like_target_role,
    try_link_selectors,
    try_selectors,
)

BASE = "https://www.instahyre.com"


def _search_urls(query: str) -> list[str]:
    q = quote(query)
    return [
        f"{BASE}/job-search/?q={q}&location=India",
        f"{BASE}/jobs/?q={q}&location=India",
        f"{BASE}/search?q={q}",
    ]


async def scrape_instahyre(queries: list[str], credentials: dict) -> list[dict]:
    jobs: list[dict] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=LOW_MEM_CHROMIUM_ARGS)
        context = await new_stealth_context(browser)
        page = await context.new_page()

        if credentials.get("username") and credentials.get("password"):
            await _safe_login(page, credentials, "instahyre", f"{BASE}/login/")

        for query in queries:
            # 45s per query — Instahyre's search consistently returns 0 from
            # public (non-logged-in) scraping because their listings are
            # gated behind auth. Bounded short so we don't burn budget on a
            # source that historically produces nothing.
            try:
                found = await asyncio.wait_for(
                    _scrape_one_query(page, query), timeout=45
                )
                jobs.extend(found)
                print(f"[instahyre] '{query}' → {len(found)} jobs")
            except asyncio.TimeoutError:
                print(f"[instahyre] '{query}' timed out after 45s")
            except Exception as e:
                print(f"[instahyre] '{query}': {type(e).__name__}: {e}")

        await context.close()
        await browser.close()
    return jobs


async def _scrape_one_query(page, query: str) -> list[dict]:
    for url in _search_urls(query):
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=25000)
            try:
                await page.wait_for_load_state("networkidle", timeout=10000)
            except PlaywrightTimeout:
                pass

            # Trigger lazy-load: scroll twice with a short pause
            for _ in range(2):
                await page.evaluate("window.scrollBy(0, 800)")
                await page.wait_for_timeout(800)

            found = await _extract_cards(page)
            if found:
                return found
        except PlaywrightTimeout:
            print(f"[instahyre] timeout {url}")
        except Exception as e:
            print(f"[instahyre] {url}: {type(e).__name__}: {e}")
    return []


async def _extract_cards(page) -> list[dict]:
    card_selectors = [
        ".opportunity-info",
        ".job-card",
        ".job-listing",
        ".opportunity-card",
        "[data-test='job-card']",
        "div.row.opportunity",
        "li.job",
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
                    ".role", ".job-title", "h2", "h3", ".designation", "a.title",
                ])
                company = await try_selectors(card, [
                    ".company-name", ".company", ".employer",
                ])
                loc = await try_selectors(card, [
                    ".location", ".loc", ".job-location",
                ])
                href = await try_link_selectors(card, [
                    "a[href*='/jobs/']", "a[href*='/opportunity']", "a",
                ])
                if not title or not href:
                    continue

                # Instahyre's opportunity card shows experience-required, the
                # match-percent badge, and a stack-of-skills row. Capture the
                # bits that are useful for keyword-based match scoring.
                experience = await try_selectors(card, [
                    ".experience", ".exp", ".years-of-exp", ".min-exp",
                ])
                desc = await try_selectors(card, [
                    ".job-description", ".description", ".excerpt", ".summary",
                ])
                salary = await try_selectors(card, [
                    ".salary", ".compensation", ".ctc",
                ])
                posted = await try_selectors(card, [
                    ".posted-on", ".time-posted", ".date",
                ])
                skills = ""
                for tags_root in (".skills", ".skill-list", "ul.skill-tags", ".technologies"):
                    skills = await collect_tag_texts(card, tags_root, "li")
                    if skills:
                        break
                if not skills:
                    # Some layouts use a div with span chips instead of <li>
                    for tags_root in (".skills", ".skill-list"):
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

    # Generic anchor fallback. Instahyre job pages live under /opportunity/<id>
    # and /jobs/<id>.
    anchors = await page.query_selector_all(
        "a[href*='/opportunity'], a[href*='/jobs/']"
    )
    seen: set[str] = set()
    for a in anchors[:60]:
        try:
            href = await a.get_attribute("href")
            text = (await a.inner_text() or "").strip()
            if not href or not text or href in seen:
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
