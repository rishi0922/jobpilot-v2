"""
Hirist.tech scraper.

Hirist's `it-jobs-in-india/<slug>-jobs` URL pattern has been replaced by a
straight `/search/<slug>-jobs` route in the current site. The earlier scraper
also raced the JS render — the listings appear after a `/api/v1/search` XHR.

This rewrite:
  - Tries the current `/search/...` URL plus the legacy URL shape.
  - Waits for networkidle to let the listings load.
  - Walks card selectors then falls back to anchor scraping.
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

BASE = "https://www.hirist.tech"


def _search_urls(query: str) -> list[str]:
    slug = quote(query.replace(" ", "-").lower())
    q = quote(query)
    return [
        f"{BASE}/search/{slug}-jobs",
        f"{BASE}/jobs/{slug}",
        f"{BASE}/it-jobs-in-india/{slug}-jobs",  # legacy
        f"{BASE}/search?q={q}",
    ]


async def scrape_hirist(queries: list[str], _credentials: dict) -> list[dict]:
    jobs: list[dict] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=LOW_MEM_CHROMIUM_ARGS)
        context = await new_stealth_context(browser)

        for query in queries:
            # 120s per query covers Hirist's 4-URL retry pattern (~25s goto
            # × 4 URLs + networkidle/wait overhead).
            #
            # Each query gets its OWN page: asyncio.wait_for cancels the
            # coroutine mid-Playwright-op on timeout, corrupting the page
            # (InvalidStateError on next use). A throwaway page per query
            # isolates that, so a timeout no longer kills the remaining
            # queries for this source.
            page = await context.new_page()
            try:
                found = await asyncio.wait_for(
                    _scrape_one_query(page, query), timeout=120
                )
                jobs.extend(found)
                print(f"[hirist] '{query}' → {len(found)} jobs")
            except asyncio.TimeoutError:
                print(f"[hirist] '{query}' timed out after 120s")
            except Exception as e:
                print(f"[hirist] '{query}': {type(e).__name__}: {e}")
            finally:
                try:
                    await page.close()
                except Exception:
                    pass

        await context.close()
        await browser.close()
    return jobs


async def _scrape_one_query(page, query: str) -> list[dict]:
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
            print(f"[hirist] timeout {url}")
        except Exception as e:
            print(f"[hirist] {url}: {type(e).__name__}: {e}")
    return []


async def _extract_cards(page) -> list[dict]:
    card_selectors = [
        ".jobpost",
        ".job-listing article",
        ".job-card",
        ".job-tuple",
        "article.searchListing",
        "div[class*='JobCard']",
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
                    "h2 a", "h3 a", ".job-title a", "a.title", ".jobtitle",
                ])
                company = await try_selectors(card, [
                    ".company-name", ".company", ".orgname", ".jcompname",
                ])
                loc = await try_selectors(card, [
                    ".location", ".loc", ".joblocation",
                ])
                href = await try_link_selectors(card, [
                    "h2 a", "h3 a", ".job-title a", "a[href*='/j/']", "a[href*='/job/']", "a",
                ])
                if not title or not href:
                    continue

                # Hirist cards expose experience-range, posted-when, skill
                # chips and a short blurb. Pull them all into the description
                # field so match-scoring has more to work with.
                experience = await try_selectors(card, [
                    ".exp", ".experience", ".jobexp", ".years-exp",
                ])
                desc = await try_selectors(card, [
                    ".jobdesc", ".job-desc", ".job-description", ".description",
                ])
                posted = await try_selectors(card, [
                    ".posted-date", ".date", ".jobtime", ".time",
                ])
                salary = await try_selectors(card, [
                    ".salary", ".sal", ".ctc",
                ])
                skills = ""
                for tags_root in ("ul.skills", "ul.tags", ".skill-list", ".jobtags"):
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

    anchors = await page.query_selector_all(
        "a[href*='/j/'], a[href*='/job/'], a[href*='/jobs/']"
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
