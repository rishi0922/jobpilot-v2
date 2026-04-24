"""Hirist.tech scraper — no login required"""
from datetime import datetime
from playwright.async_api import async_playwright
from urllib.parse import quote

async def scrape_hirist(queries: list[str], _credentials: dict) -> list[dict]:
    jobs = []
    BASE = "https://www.hirist.tech"
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )
        page = await context.new_page()

        for query in queries:
            try:
                url = f"{BASE}/it-jobs-in-india/{quote(query.replace(' ', '-'))}-jobs"
                await page.goto(url, wait_until="domcontentloaded", timeout=25000)
                await page.wait_for_timeout(2000)
                cards = await page.query_selector_all(".jobpost, .job-listing article")
                for card in cards[:20]:
                    try:
                        t = await card.query_selector("h2 a, .job-title a")
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
                print(f"[hirist] {query}: {e}")

        await browser.close()
    return jobs
