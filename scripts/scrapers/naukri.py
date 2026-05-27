"""
Naukri.com scraper.

Why this is browser-only:

  A direct HTTP call to Naukri's JSON search API
  (https://www.naukri.com/jobapi/v3/search) now returns HTTP 406 with
  `{"message":"recaptcha required"}` — confirmed live. So the "fast HTTP path"
  the previous version of this scraper used as primary doesn't work anymore
  no matter what headers we send.

  The SEO landing pages
  (https://www.naukri.com/{role-slug}-jobs-in-{location}-{offset}) DO render,
  but only client-side: the HTML body is a vanilla Next.js shell that hydrates
  jobs via XHR after page load. That XHR runs inside the real browser, where
  cookies and bot-check tokens are set automatically, so the same JSON API
  that 406s for httpx returns 200 for a real Playwright page.

Strategy:

  1. Load the SEO URL in Playwright.
  2. Once the page has settled, run `page.evaluate(fetch('/jobapi/v3/search'))`
     to pull the JSON API response with first-party cookies attached. Each
     job object is rich (title, company, location, salary, description,
     skills, posted date) — much better than DOM-scraping.
  3. If that fails for any reason, fall back to scraping the rendered
     `.srp-jobtuple-wrapper` cards directly.
  4. Paginate via `-20`, `-40`, ... URL suffixes until a page returns zero
     jobs or we hit our page cap.

Pagination quirk we handle: `/.../india-0` 301s to `/.../india` (no suffix),
but `/.../india-20`, `/.../india-40` resolve directly. We never request `-0`.
"""

import asyncio
from datetime import datetime
from typing import Optional
from urllib.parse import quote

from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout

from ._common import (
    _safe_login,
    build_rich_description,
    collect_tag_texts,
    new_stealth_context,
    normalize_url,
    try_link_selectors,
    try_selectors,
)

BASE_URL = "https://www.naukri.com"

# How many SEO-URL pages to crawl per query. 3 × 20 = up to 60 jobs/query.
HTML_PAGES_PER_QUERY = 3
HTML_RESULTS_PER_PAGE = 20


async def scrape_naukri(queries: list[str], credentials: dict) -> list[dict]:
    """Scrape Naukri for each query.

    All paths run inside a single Playwright session because the JSON API
    requires the bot-check cookie that Naukri sets after the first page load.
    """
    jobs: list[dict] = []
    seen: set[str] = set()

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        )
        context = await new_stealth_context(browser)
        page = await context.new_page()

        # Visit the homepage once so Naukri can set its first-party cookies
        # (bot-check token, geo, etc.). This is what lets the subsequent
        # JSON API calls succeed instead of returning HTTP 406.
        try:
            await page.goto(BASE_URL, wait_until="domcontentloaded", timeout=20000)
            try:
                await page.wait_for_load_state("networkidle", timeout=8000)
            except PlaywrightTimeout:
                pass
        except Exception as e:
            print(f"[naukri] homepage warm-up failed: {type(e).__name__}: {e}")

        if credentials.get("username") and credentials.get("password"):
            await _safe_login(page, credentials, "naukri", f"{BASE_URL}/nlogin/login")

        for query in queries:
            kept_for_query = 0

            # Per-query timeout. Naukri can hang on any one of: homepage
            # warm-up redirect, page goto, in-browser fetch, or networkidle.
            # 90s budget covers 3 pages × ~25s each even on a slow run.
            try:
                kept_for_query = await asyncio.wait_for(
                    _scrape_query_pages(page, query, jobs, seen),
                    timeout=90,
                )
            except asyncio.TimeoutError:
                print(f"[naukri] '{query}' timed out after 90s")
                kept_for_query = 0

            print(f"[naukri] '{query}' → {kept_for_query} jobs across "
                  f"{HTML_PAGES_PER_QUERY} pages")

        await context.close()
        await browser.close()

    return jobs


async def _scrape_query_pages(page, query: str, jobs: list[dict], seen: set[str]) -> int:
    """Walk the per-query pagination and append new rows to `jobs`. Returns
    how many rows we kept for this query. Extracted out so the caller can
    wrap it in asyncio.wait_for without losing partial progress."""
    kept_for_query = 0
    for page_idx in range(HTML_PAGES_PER_QUERY):
        offset = page_idx * HTML_RESULTS_PER_PAGE
        url = _seo_url(query, offset)
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        except PlaywrightTimeout:
            print(f"[naukri] timeout loading {url}")
            break
        except Exception as e:
            print(f"[naukri] error loading {url}: {type(e).__name__}: {e}")
            break

        # Wait for either the JSON XHR to settle OR the cards to render.
        try:
            await page.wait_for_selector(
                "div.srp-jobtuple-wrapper, article.jobTuple",
                timeout=12000,
            )
        except PlaywrightTimeout:
            # Cards didn't appear. Could be that the JSON path responded
            # but the renderer hasn't drawn yet. We still try the in-browser
            # API fetch below before giving up.
            pass

        # ── Path A: in-browser JSON fetch ───────────────────────
        api_rows = await _fetch_via_page(page, query, page_idx + 1)
        added_from_api = 0
        for row in api_rows:
            src = row.get("sourceUrl")
            if not src or src in seen:
                continue
            seen.add(src)
            jobs.append(row)
            added_from_api += 1

        # ── Path B: rendered-DOM fallback ───────────────────────
        added_from_dom = 0
        if added_from_api == 0:
            dom_rows = await _scrape_rendered_cards(page)
            for row in dom_rows:
                src = row.get("sourceUrl")
                if not src or src in seen:
                    continue
                seen.add(src)
                jobs.append(row)
                added_from_dom += 1

        # ── Path C: inline-script JSON fallback ─────────────────
        added_from_inline = 0
        if added_from_api == 0 and added_from_dom == 0:
            inline_rows = await _fetch_inline_json(page)
            for row in inline_rows:
                src = row.get("sourceUrl")
                if not src or src in seen:
                    continue
                seen.add(src)
                jobs.append(row)
                added_from_inline += 1

        added_this_page = added_from_api + added_from_dom + added_from_inline
        kept_for_query += added_this_page
        tag = (
            "api"    if added_from_api    else
            "dom"    if added_from_dom    else
            "inline" if added_from_inline else
            "empty"
        )
        print(
            f"[naukri] '{query}' page={page_idx+1} offset={offset} "
            f"+{added_this_page} ({tag})"
        )

        # If a page returned nothing, further pages probably will too.
        if added_this_page == 0:
            break

    return kept_for_query


def _seo_url(query: str, offset: int) -> str:
    """Build the Naukri SEO landing URL. `offset=0` redirects to the no-suffix
    URL — we skip that 301 by using the bare URL when offset is 0."""
    slug = query.replace(" ", "-").lower()
    if offset == 0:
        return f"{BASE_URL}/{slug}-jobs-in-india"
    return f"{BASE_URL}/{slug}-jobs-in-india-{offset}"


# ── Path A: in-browser JSON fetch ───────────────────────────────────────────

async def _fetch_via_page(page, query: str, page_no: int) -> list[dict]:
    """Call Naukri's JSON search API from inside the rendered page, so
    cookies + bot-check tokens are attached automatically. Tries /v3 first,
    then /v4 — Naukri has historically published both side-by-side and
    rotates which one is the recaptcha-gated mirror. Returns [] on any
    failure — caller falls back to rendered-DOM scraping."""
    params = {
        "noOfResults": HTML_RESULTS_PER_PAGE,
        "urlType":     "search_by_keyword",
        "searchType":  "adv",
        "keyword":     query,
        "pageNo":      page_no,
        "experience":  "0",
        "location":    "india",
        "k":           query,
        "seoKey":      f"{query.replace(' ', '-').lower()}-jobs",
    }
    qs = "&".join(f"{k}={quote(str(v))}" for k, v in params.items())
    js = """
    async ({qs}) => {
      // Try v3 then v4. The header set Naukri's JS client uses has rotated
      // a couple of times — we send a superset that has worked in all the
      // versions seen in the last 18 months.
      const HEADERS = {
        'appid': '109',
        'systemid': 'Naukri',
        'clientid': 'd3skt0p',
        'Accept': 'application/json',
        'gid': 'LOCATION,INDUSTRY,EDUCATION,FAREA_ROLE',
      };
      for (const ver of ['v3', 'v4']) {
        try {
          const r = await fetch('/jobapi/' + ver + '/search?' + qs, {
            headers: HEADERS,
            credentials: 'include',
          });
          if (r.ok) {
            const json = await r.json();
            return { json, ver };
          }
          // 4xx/5xx — try the next version.
          if (ver === 'v4') return { error: 'HTTP ' + r.status };
        } catch (e) {
          if (ver === 'v4') return { error: String(e) };
        }
      }
      return { error: 'no version responded' };
    }
    """
    try:
        result = await page.evaluate(js, {"qs": qs})
    except Exception as e:
        print(f"[naukri] in-browser fetch error: {type(e).__name__}: {e}")
        return []

    if not isinstance(result, dict):
        return []
    if "error" in result:
        print(f"[naukri] in-browser API error: {result.get('error')}")
        return []

    data = result.get("json") or {}
    out: list[dict] = []
    for j in data.get("jobDetails", []) or []:
        title = (j.get("title") or "").strip()
        if not title:
            continue
        company = (j.get("companyName") or "").strip()

        placeholders = j.get("placeholders") or []
        location = _placeholder(placeholders, "location") or "India"
        salary   = _placeholder(placeholders, "salary")
        exp      = _placeholder(placeholders, "experience")

        href = j.get("jdURL") or j.get("staticUrl") or ""
        if not href:
            continue
        href = href if href.startswith("http") else f"{BASE_URL}{href}"
        href = href.split("?")[0]

        # Tag chips on the listing card
        tags = j.get("tagsAndSkills") or ""
        if isinstance(tags, list):
            tags = ", ".join(str(t) for t in tags if t)

        out.append({
            "title":       title,
            "company":     company,
            "location":    location,
            "salary":      salary,
            "sourceUrl":   href,
            "description": build_rich_description(
                (j.get("jobDescription") or "").strip(),
                experience=exp or "",
                skills=tags or "",
            ),
            "postedAt":    _ms_epoch_to_iso(j.get("createdDate")),
            "scrapedAt":   datetime.utcnow().isoformat(),
        })
    return out


def _placeholder(items: list[dict], kind: str) -> Optional[str]:
    """Read one labelled value out of a Naukri placeholders array."""
    for it in items:
        if it.get("type") == kind:
            val = (it.get("label") or "").strip()
            if val:
                return val
    return None


def _ms_epoch_to_iso(ms: object) -> Optional[str]:
    if not ms:
        return None
    try:
        return datetime.utcfromtimestamp(int(ms) / 1000).isoformat()
    except Exception:
        return None


# ── Path C: inline-script JSON scrape ───────────────────────────────────────

async def _fetch_inline_json(page) -> list[dict]:
    """Look for an embedded JSON blob in the page that contains the job
    listings. Naukri's SSR puts them into a window-level state object;
    the exact variable name has rotated, so we scan all <script> tags
    rather than hard-code a key. Returns at most HTML_RESULTS_PER_PAGE rows.

    This is a fragile path but better than returning 0 when both the
    in-browser API and the DOM cards have failed."""
    js = r"""
    () => {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const s of scripts) {
        const txt = s.textContent || '';
        if (!txt.includes('jobDetails') && !txt.includes('jobsList')) continue;
        // Try to surface any JSON-looking substring that has a jobDetails or
        // jobsList array. Search for the first '{' through the matching
        // closing '}' — naive but works because Naukri's blob is one object.
        const startKeys = ['jobDetails', 'jobsList'];
        for (const key of startKeys) {
          const i = txt.indexOf('"' + key + '"');
          if (i < 0) continue;
          // Walk back to the nearest opening '{' that's the parent object.
          let braceStart = txt.lastIndexOf('{', i);
          let depth = 0;
          let end = -1;
          for (let j = braceStart; j < txt.length; j++) {
            const ch = txt[j];
            if (ch === '{') depth++;
            else if (ch === '}') {
              depth--;
              if (depth === 0) { end = j; break; }
            }
          }
          if (end < 0) continue;
          try {
            const blob = JSON.parse(txt.slice(braceStart, end + 1));
            const list = blob.jobDetails || blob.jobsList || [];
            if (Array.isArray(list) && list.length > 0) return list;
          } catch (e) { /* keep trying */ }
        }
      }
      return [];
    }
    """
    try:
        items = await page.evaluate(js)
    except Exception as e:
        print(f"[naukri] inline JSON eval error: {type(e).__name__}: {e}")
        return []

    out: list[dict] = []
    if not isinstance(items, list):
        return out
    for j in items[:HTML_RESULTS_PER_PAGE]:
        if not isinstance(j, dict):
            continue
        title = (j.get("title") or j.get("jobTitle") or "").strip()
        if not title:
            continue
        company = (j.get("companyName") or j.get("company") or "").strip()
        href = j.get("jdURL") or j.get("staticUrl") or j.get("jobUrl") or ""
        if not href:
            continue
        href = href if href.startswith("http") else f"{BASE_URL}{href}"
        href = href.split("?")[0]
        out.append({
            "title":       title,
            "company":     company,
            "location":    (j.get("placeholders", [{}])[0].get("label", "") if j.get("placeholders") else "") or "India",
            "salary":      None,
            "sourceUrl":   href,
            "description": (j.get("jobDescription") or "").strip()[:4000] or None,
            "postedAt":    _ms_epoch_to_iso(j.get("createdDate")),
            "scrapedAt":   datetime.utcnow().isoformat(),
        })
    return out


# ── Path B: rendered-DOM card scrape ────────────────────────────────────────

async def _scrape_rendered_cards(page) -> list[dict]:
    """Walk the rendered `.srp-jobtuple-wrapper` cards. Used when the
    in-browser API fetch failed. Selector list is the union of what we had
    plus what the upstream `naukri-job-scraper-dashboard` repo uses."""
    out: list[dict] = []
    cards = await page.query_selector_all(
        "div.srp-jobtuple-wrapper, article.jobTuple, .jobTuple"
    )
    for card in cards[:HTML_RESULTS_PER_PAGE]:
        row = await _parse_card(card)
        if row:
            out.append(row)
    return out


async def _parse_card(card) -> Optional[dict]:
    try:
        title = await try_selectors(card, [
            "a.title", ".title", ".jobTitle", "a.jobTitle", "h2 a",
        ])
        href = await try_link_selectors(card, [
            "a.title", "a.jobTitle", "a[href*='/job-listings/']", "a",
        ])
        if not title or not href:
            return None

        company = await try_selectors(card, [
            "a.comp-name", ".comp-name", ".companyInfo a",
            ".subTitle", ".company-name",
        ])
        loc = await try_selectors(card, [
            "span.locWdth", ".locWdth", ".location", ".loc", ".job-location",
        ])
        salary = await try_selectors(card, [
            ".salary", ".sal", ".salaryAndExp .salary", "span.sal",
        ])
        experience = await try_selectors(card, [
            "span.expwdth", ".expwdth", ".exp", ".experience",
        ])
        desc = await try_selectors(card, [
            "span.job-desc", ".job-desc", ".job-description",
        ])
        posted = await try_selectors(card, [
            "span.job-post-day", ".job-post-day", ".date", ".posted",
        ])

        # Skill chips
        skills_text = await collect_tag_texts(card, "ul.tags-gt", "li")

        return {
            "title":       title,
            "company":     company,
            "location":    loc or "India",
            "salary":      salary or None,
            "sourceUrl":   normalize_url(BASE_URL, href),
            "description": build_rich_description(
                desc, experience=experience, skills=skills_text, posted=posted
            ),
            "postedAt":    None,  # text like "1 day ago" — leave as null
            "scrapedAt":   datetime.utcnow().isoformat(),
        }
    except Exception:
        return None


# ── Login: handled by shared `_safe_login` in scrapers._common ──────────────
