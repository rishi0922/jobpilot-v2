"""
MNC career site scraper.
Each company has a config entry with their careers URL and CSS selectors.
Falls back to a generic approach if selectors miss.
"""
from datetime import datetime
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout

ROLE_KEYWORDS = [
    "product manager", "associate product manager", "apm",
    "project manager", "program manager", "business analyst",
]

# Each entry: (company, careers_url, search_param, title_sel, company_sel, loc_sel, link_sel)
MNC_CONFIGS = [
    {
        "company": "TCS",
        "url": "https://www.tcs.com/careers/tcs-ibegin",
        "search_url": "https://ibegin.tcs.com/iBegin/faces/Visitor/Visitor_register.xhtml",
        "title_sel": ".jd-title, .job-title",
        "loc_sel": ".location",
        "link_sel": "a",
    },
    {
        "company": "Cognizant",
        "url": "https://careers.cognizant.com/global/en/search-results",
        "search_url": "https://careers.cognizant.com/global/en/search-results?keywords=product+manager&location=India",
        "title_sel": ".job-title, h2",
        "loc_sel": ".job-location",
        "link_sel": "a.job-title",
    },
    {
        "company": "Accenture",
        "url": "https://www.accenture.com/in-en/careers/jobsearch",
        "search_url": "https://www.accenture.com/in-en/careers/jobsearch?jk=product+manager&country=India",
        "title_sel": ".cmp-teaser__title, h3",
        "loc_sel": ".location-info",
        "link_sel": "a.cmp-teaser__action-link",
    },
    {
        "company": "Wipro",
        "url": "https://careers.wipro.com/careers-home/jobs",
        "search_url": "https://careers.wipro.com/careers-home/jobs#?q=product+manager&location=India",
        "title_sel": ".job-title, h2.title",
        "loc_sel": ".job-location",
        "link_sel": "a",
    },
    {
        "company": "LTIMindtree",
        "url": "https://www.ltimindtree.com/careers/job-search/",
        "search_url": "https://www.ltimindtree.com/careers/job-search/?searchTerm=product+manager",
        "title_sel": ".job-title, h3",
        "loc_sel": ".location",
        "link_sel": "a",
    },
    {
        "company": "HCLTech",
        "url": "https://www.hcltech.com/careers",
        "search_url": "https://www.hcltech.com/careers/search-jobs#q=product+manager&t=Jobs&sort=relevancy",
        "title_sel": ".CoveoResultLink, h3.title",
        "loc_sel": ".coveo-field-location",
        "link_sel": "a.CoveoResultLink",
    },
    {
        "company": "Genpact",
        "url": "https://www.genpact.com/careers",
        "search_url": "https://genpact.taleo.net/careersection/genpact_ex/jobsearch.ftl?lang=en&keyword=product+manager",
        "title_sel": ".jobTitle, td.titreCol a",
        "loc_sel": ".location",
        "link_sel": "td.titreCol a",
    },
    {
        "company": "Deloitte",
        "url": "https://apply.deloitte.com/careers/SearchJobs",
        "search_url": "https://apply.deloitte.com/careers/SearchJobs/product%20manager?listFilterMode=1&jobOffset=0",
        "title_sel": ".opportunity-job-title, h3",
        "loc_sel": ".opportunity-location",
        "link_sel": "a.opportunity-title",
    },
    {
        "company": "KPMG",
        "url": "https://kpmg.com/in/en/careers.html",
        "search_url": "https://jobs.kpmg.com/KPMG/search/?q=product+manager&locationsearch=India",
        "title_sel": ".job-title, h2",
        "loc_sel": ".location",
        "link_sel": "a",
    },
    {
        "company": "EY",
        "url": "https://careers.ey.com/ey/search/",
        "search_url": "https://careers.ey.com/ey/search/?q=product+manager&location=India",
        "title_sel": ".job-title, h3.title",
        "loc_sel": ".location",
        "link_sel": "a.job-title-link",
    },
    {
        "company": "PhonePe",
        "url": "https://www.phonepe.com/careers/",
        "search_url": "https://www.phonepe.com/careers/#open-positions",
        "title_sel": ".position-title, h3, .job-title",
        "loc_sel": ".location",
        "link_sel": "a",
    },
    {
        "company": "Razorpay",
        "url": "https://razorpay.com/jobs/",
        "search_url": "https://razorpay.com/jobs/",
        "title_sel": ".job-listing__title, h3",
        "loc_sel": ".job-listing__location",
        "link_sel": "a.job-listing__link, a",
    },
    {
        "company": "Juspay",
        "url": "https://juspay.in/careers",
        "search_url": "https://juspay.in/careers",
        "title_sel": ".job-title, h3, .opening-title",
        "loc_sel": ".location",
        "link_sel": "a",
    },
    {
        "company": "Flipkart",
        "url": "https://www.flipkartcareers.com/#!/joblist",
        "search_url": "https://www.flipkartcareers.com/#!/joblist",
        "title_sel": ".job-title, h3",
        "loc_sel": ".location",
        "link_sel": "a",
    },
    {
        "company": "Uber",
        "url": "https://www.uber.com/in/en/careers/list/",
        "search_url": "https://www.uber.com/in/en/careers/list/?query=product+manager&location=India",
        "title_sel": "[data-test='job-title'], h3",
        "loc_sel": "[data-test='job-location']",
        "link_sel": "a[data-test='job-title-link'], a",
    },
    {
        "company": "Paytm",
        "url": "https://paytm.com/about-us/careers/",
        "search_url": "https://paytmjobs.com/jobs?q=product+manager",
        "title_sel": ".job-title, h2, h3",
        "loc_sel": ".location",
        "link_sel": "a",
    },
    {
        "company": "MakeMyTrip",
        "url": "https://careers.makemytrip.com/",
        "search_url": "https://careers.makemytrip.com/jobs/?q=product+manager",
        "title_sel": ".job-title, h3",
        "loc_sel": ".job-location",
        "link_sel": "a",
    },
    {
        "company": "Goibibo",
        "url": "https://careers.goibibo.com/",
        "search_url": "https://careers.goibibo.com/jobs/?q=product+manager",
        "title_sel": ".job-title, h3",
        "loc_sel": ".location",
        "link_sel": "a",
    },
    {
        "company": "Amazon",
        "url": "https://amazon.jobs/en/search",
        "search_url": "https://amazon.jobs/en/search?base_query=product+manager&loc_query=India",
        "title_sel": "h3.job-title, .job-title",
        "loc_sel": ".location-and-id .location",
        "link_sel": "a.job-link",
    },
    {
        "company": "Sprinklr",
        "url": "https://www.sprinklr.com/careers/",
        "search_url": "https://www.sprinklr.com/careers/#open-roles",
        "title_sel": ".job-title, h3",
        "loc_sel": ".location",
        "link_sel": "a",
    },
]

def _is_relevant(title: str) -> bool:
    t = title.lower()
    return any(k in t for k in ROLE_KEYWORDS)

async def scrape_mnc_sites() -> list[dict]:
    jobs = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])

        for cfg in MNC_CONFIGS:
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
            )
            page = await context.new_page()
            try:
                await page.goto(cfg["search_url"], wait_until="domcontentloaded", timeout=30000)
                await page.wait_for_timeout(3000)

                # Scroll to load dynamic content
                for _ in range(3):
                    await page.evaluate("window.scrollBy(0, 700)")
                    await page.wait_for_timeout(600)

                cards = await page.query_selector_all("li, article, .job-item, .job-card, tr.data-row")
                for card in cards[:30]:
                    try:
                        t = await card.query_selector(cfg["title_sel"])
                        l = await card.query_selector(cfg["loc_sel"])
                        a = await card.query_selector(cfg["link_sel"])
                        title = (await t.inner_text()).strip() if t else ""
                        loc   = (await l.inner_text()).strip() if l else "India"
                        href  = await a.get_attribute("href")  if a else None

                        if not title or not href or not _is_relevant(title):
                            continue

                        base = cfg["url"].rsplit("/", 1)[0]
                        url2 = href if href.startswith("http") else f"https:{href}" if href.startswith("//") else f"{base}/{href.lstrip('/')}"
                        jobs.append({
                            "title":     title,
                            "company":   cfg["company"],
                            "location":  loc,
                            "sourceUrl": url2,
                            "salary":    None,
                            "scrapedAt": datetime.utcnow().isoformat(),
                        })
                    except Exception:
                        continue

            except PlaywrightTimeout:
                print(f"[mnc] Timeout: {cfg['company']}")
            except Exception as e:
                print(f"[mnc] {cfg['company']}: {e}")
            finally:
                await context.close()

        await browser.close()
    return jobs
