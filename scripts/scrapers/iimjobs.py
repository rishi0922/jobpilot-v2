"""IIMJobs scraper"""
import asyncio
from datetime import datetime
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout
from urllib.parse import quote

BASE = "https://www.iimjobs.com"

async def scrape_iimjobs(queries: list[str], credentials: dict) -> list[dict]:
    jobs = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
        )
        page = await context.new_page()

        if credentials.get("username") and credentials.get("password"):
            try:
                await page.goto(f"{BASE}/candidate/login", wait_until="domcontentloaded", timeout=20000)
                await page.wait_for_timeout(1500)
                await page.fill('input[name="email"]', credentials["username"])
                await page.fill('input[name="password"]', credentials["password"])
                await page.click('button[type="submit"]')
                await page.wait_for_timeout(3000)
            except Exception as e:
                print(f"[iimjobs] Login failed: {e}")

        for query in queries:
            try:
                url = f"{BASE}/jobs/search/?search_keyword={quote(query)}&experience=0to5"
                await page.goto(url, wait_until="domcontentloaded", timeout=25000)
                await page.wait_for_timeout(2000)
                cards = await page.query_selector_all(".job-wrap, .jobListItem")
                for card in cards[:20]:
                    try:
                        t = await card.query_selector(".job-title a, h2 a")
                        c = await card.query_selector(".company-name, .company")
                        l = await card.query_selector(".location")
                        title   = (await t.inner_text()).strip() if t else ""
                        company = (await c.inner_text()).strip() if c else ""
                        loc     = (await l.inner_text()).strip() if l else ""
                        href    = await t.get_attribute("href")  if t else None
                        if title and href:
                            url2 = href if href.startswith("http") else f"{BASE}{href}"
                            jobs.append({"title": title, "company": company, "location": loc,
                                         "sourceUrl": url2, "salary": None,
                                         "scrapedAt": datetime.utcnow().isoformat()})
                    except Exception:
                        continue
            except Exception as e:
                print(f"[iimjobs] {query}: {e}")

        await browser.close()
    return jobs
