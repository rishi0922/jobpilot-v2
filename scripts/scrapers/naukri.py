"""
Naukri.com scraper — searches for PM/APM/BA/PM roles.
Uses Playwright headless browser to handle JS rendering and login.
"""

import asyncio
import re
from datetime import datetime
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout

BASE_URL = "https://www.naukri.com"

async def scrape_naukri(queries: list[str], credentials: dict) -> list[dict]:
    jobs = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
        )
        page = await context.new_page()

        # Login if credentials provided
        if credentials.get("username") and credentials.get("password"):
            await _login(page, credentials)

        for query in queries:
            try:
                slug    = query.replace(" ", "-")
                url     = f"{BASE_URL}/{slug}-jobs?experience=0,5&location=india"
                await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                await page.wait_for_timeout(2000)

                cards = await page.query_selector_all(".srp-jobtuple-wrapper, article.jobTuple")
                for card in cards[:25]:
                    try:
                        job = await _parse_card(card, page)
                        if job:
                            jobs.append(job)
                    except Exception:
                        continue
            except PlaywrightTimeout:
                print(f"[naukri] Timeout for query: {query}")
            except Exception as e:
                print(f"[naukri] Error for query {query}: {e}")

        await browser.close()

    # Deduplicate by URL
    seen = set()
    unique = []
    for j in jobs:
        if j["sourceUrl"] not in seen:
            seen.add(j["sourceUrl"])
            unique.append(j)
    return unique

async def _login(page, creds: dict):
    try:
        await page.goto(f"{BASE_URL}/nlogin/login", wait_until="domcontentloaded", timeout=20000)
        await page.wait_for_timeout(1500)
        await page.fill('input[placeholder*="Enter your active Email ID"]', creds["username"])
        await page.fill('input[placeholder*="Enter your password"]', creds["password"])
        await page.click('button[type="submit"]')
        await page.wait_for_timeout(3000)
    except Exception as e:
        print(f"[naukri] Login failed: {e}")

async def _parse_card(card, page) -> dict | None:
    try:
        title_el    = await card.query_selector(".title, .jobTitle, a.title")
        company_el  = await card.query_selector(".comp-name, .companyInfo a")
        location_el = await card.query_selector(".locWdth, .location")
        salary_el   = await card.query_selector(".salary, .sal")
        link_el     = await card.query_selector("a.title, a.jobTitle")

        title   = (await title_el.inner_text()).strip()    if title_el    else ""
        company = (await company_el.inner_text()).strip()  if company_el  else ""
        loc     = (await location_el.inner_text()).strip() if location_el else ""
        salary  = (await salary_el.inner_text()).strip()   if salary_el   else None
        href    = await link_el.get_attribute("href")      if link_el     else None

        if not title or not href:
            return None

        # Normalise URL
        url = href if href.startswith("http") else f"{BASE_URL}{href}"

        return {
            "title":     title,
            "company":   company,
            "location":  loc,
            "salary":    salary,
            "sourceUrl": url,
            "scrapedAt": datetime.utcnow().isoformat(),
        }
    except Exception:
        return None
