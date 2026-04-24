"""
LinkedIn job scraper.
Uses the public jobs search (no auth required for scraping).
Login credentials used only if 'Easy Apply' flow is needed.
"""

import asyncio
from datetime import datetime
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout
from urllib.parse import urlencode

BASE_URL = "https://www.linkedin.com"

LOCATION_GEO_ID = "102713980"  # India

async def scrape_linkedin(queries: list[str], credentials: dict) -> list[dict]:
    jobs = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
            locale="en-IN",
        )
        page = await context.new_page()

        # Login for Easy Apply access
        if credentials.get("username") and credentials.get("password"):
            await _login(page, credentials)

        for query in queries:
            try:
                params = urlencode({
                    "keywords": query,
                    "location": "India",
                    "geoId":    LOCATION_GEO_ID,
                    "f_TPR":    "r604800",   # past week
                    "f_E":      "1,2",       # entry to mid level
                    "start":    "0",
                })
                url = f"{BASE_URL}/jobs/search/?{params}"
                await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                await page.wait_for_timeout(2500)

                # Scroll to load more
                for _ in range(3):
                    await page.evaluate("window.scrollBy(0, 800)")
                    await page.wait_for_timeout(800)

                cards = await page.query_selector_all(".jobs-search__results-list li, .job-card-container")
                for card in cards[:20]:
                    try:
                        job = await _parse_card(card)
                        if job:
                            jobs.append(job)
                    except Exception:
                        continue
            except PlaywrightTimeout:
                print(f"[linkedin] Timeout for: {query}")
            except Exception as e:
                print(f"[linkedin] Error for {query}: {e}")

        await browser.close()

    seen = set()
    return [j for j in jobs if not (j["sourceUrl"] in seen or seen.add(j["sourceUrl"]))]

async def _login(page, creds: dict):
    try:
        await page.goto(f"{BASE_URL}/login", wait_until="domcontentloaded", timeout=20000)
        await page.wait_for_timeout(1500)
        await page.fill("#username", creds["username"])
        await page.fill("#password", creds["password"])
        await page.click('button[type="submit"]')
        await page.wait_for_timeout(4000)
    except Exception as e:
        print(f"[linkedin] Login failed: {e}")

async def _parse_card(card) -> dict | None:
    try:
        title_el   = await card.query_selector(".base-search-card__title, h3.base-search-card__title, .job-card-list__title")
        company_el = await card.query_selector(".base-search-card__subtitle, .job-card-container__company-name")
        loc_el     = await card.query_selector(".job-search-card__location, .job-card-container__metadata-item")
        link_el    = await card.query_selector("a.base-card__full-link, a.job-card-list__title")

        title   = (await title_el.inner_text()).strip()   if title_el   else ""
        company = (await company_el.inner_text()).strip() if company_el else ""
        loc     = (await loc_el.inner_text()).strip()     if loc_el     else ""
        href    = await link_el.get_attribute("href")     if link_el    else None

        if not title or not href:
            return None

        # Strip tracking params
        clean_url = href.split("?")[0] if "?" in href else href

        return {
            "title":     title,
            "company":   company,
            "location":  loc,
            "sourceUrl": clean_url,
            "salary":    None,
            "scrapedAt": datetime.utcnow().isoformat(),
        }
    except Exception:
        return None
