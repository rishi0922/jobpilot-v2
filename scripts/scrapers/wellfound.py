"""Wellfound (AngelList) scraper"""
from datetime import datetime
from playwright.async_api import async_playwright
from urllib.parse import quote

async def scrape_wellfound(queries: list[str], _credentials: dict) -> list[dict]:
    jobs = []
    BASE = "https://wellfound.com"
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
        )
        page = await context.new_page()

        for query in queries:
            try:
                url = f"{BASE}/jobs?q={quote(query)}&country=IN"
                await page.goto(url, wait_until="domcontentloaded", timeout=25000)
                await page.wait_for_timeout(3000)

                # Wellfound is React-heavy, scroll to load
                for _ in range(3):
                    await page.evaluate("window.scrollBy(0, 600)")
                    await page.wait_for_timeout(700)

                cards = await page.query_selector_all("[data-test='JobListing'], .styles_component__job")
                for card in cards[:15]:
                    try:
                        t = await card.query_selector("h2, .role-title, [data-test='JobTitle']")
                        c = await card.query_selector(".company-name, [data-test='startup-name']")
                        l = await card.query_selector(".location, [data-test='location']")
                        a = await card.query_selector("a[href*='/jobs/']")
                        title   = (await t.inner_text()).strip() if t else ""
                        company = (await c.inner_text()).strip() if c else ""
                        loc     = (await l.inner_text()).strip() if l else "India"
                        href    = await a.get_attribute("href")  if a else None
                        if title and href:
                            url2 = href if href.startswith("http") else f"{BASE}{href}"
                            jobs.append({"title": title, "company": company, "location": loc,
                                         "sourceUrl": url2, "salary": None,
                                         "scrapedAt": datetime.utcnow().isoformat()})
                    except Exception:
                        continue
            except Exception as e:
                print(f"[wellfound] {query}: {e}")

        await browser.close()
    return jobs
