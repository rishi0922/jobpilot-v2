"""
Shared helpers for Playwright-based scrapers.

The previous per-site scrapers each rolled their own browser setup with slightly
different headers, none of which were realistic enough to pass modern bot
detection on sites like Wellfound and Naukri. They also waited on
`domcontentloaded` even though every target is a JS-heavy SPA where the actual
job cards only appear after XHR finishes — that's why so many runs returned 0
jobs even when the URL was correct.

This module centralises:
  - A realistic Chrome-on-Windows fingerprint (UA, sec-ch-ua, accept-language)
  - A small set of stealth tweaks (`navigator.webdriver` patch, etc.)
  - A safe text/attr accessor that tolerates `None` elements
  - URL normalisation + tracking-param stripping for dedupe stability
  - A `try_selectors` helper that walks a list of CSS selectors and returns the
    first non-empty match — every site quietly renames its classes every few
    months, so multi-selector fallback is what keeps scrapers alive between
    maintenance cycles.
"""

from __future__ import annotations

from typing import Iterable, Optional
from urllib.parse import urlparse, urlunparse


REAL_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

# Headers a real Chrome browser sends. Several sites (Wellfound, Naukri) block
# requests that look like vanilla Playwright — the missing sec-ch-ua family is
# the most common giveaway.
REAL_BROWSER_HEADERS = {
    "Accept-Language": "en-IN,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Upgrade-Insecure-Requests": "1",
}

# JS run on every new page to patch the most obvious headless tells.
STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en'] });
Object.defineProperty(navigator, 'plugins', {
  get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }, { name: 'Native Client' }],
});
window.chrome = { runtime: {} };
"""


async def new_stealth_context(browser, *, locale: str = "en-IN"):
    """Create a Playwright browser context that looks like real Chrome and
    blocks the obvious headless detection vectors. Call this from each scraper
    instead of `browser.new_context(...)` directly."""
    context = await browser.new_context(
        user_agent=REAL_UA,
        locale=locale,
        viewport={"width": 1366, "height": 800},
        extra_http_headers=REAL_BROWSER_HEADERS,
    )
    await context.add_init_script(STEALTH_JS)
    return context


async def safe_text(card, selector: str) -> str:
    """Return inner_text of the first match or ''. Tolerates missing elements."""
    try:
        el = await card.query_selector(selector)
        if not el:
            return ""
        txt = await el.inner_text()
        return (txt or "").strip()
    except Exception:
        return ""


async def safe_attr(card, selector: str, attr: str) -> Optional[str]:
    """Return an attribute of the first match or None. Tolerates missing elements."""
    try:
        el = await card.query_selector(selector)
        if not el:
            return None
        val = await el.get_attribute(attr)
        return val
    except Exception:
        return None


async def try_selectors(card, selectors: Iterable[str]) -> str:
    """Walk a list of selectors and return inner_text from the first match.
    Useful when a site has shipped multiple card layouts side-by-side
    (A/B tests, mobile vs desktop, gradual rollout of a redesign)."""
    for sel in selectors:
        txt = await safe_text(card, sel)
        if txt:
            return txt
    return ""


async def try_link_selectors(card, selectors: Iterable[str]) -> Optional[str]:
    """Same idea as `try_selectors` but for href attributes."""
    for sel in selectors:
        href = await safe_attr(card, sel, "href")
        if href:
            return href
    return None


def normalize_url(base: str, href: str) -> str:
    """Make an href absolute, dropping ?utm/?gclid/?ref query params so two
    scrapes of the same job don't create duplicate rows just because the
    listing URL gained a tracking suffix between runs."""
    if not href:
        return ""
    if href.startswith("//"):
        href = "https:" + href
    elif href.startswith("/"):
        href = base.rstrip("/") + href
    elif not href.startswith("http"):
        href = f"{base.rstrip('/')}/{href.lstrip('/')}"

    # Strip the entire query string. We keep path + fragment so listings that
    # legitimately use # for routing (single-page sites) still work.
    try:
        u = urlparse(href)
        return urlunparse((u.scheme, u.netloc, u.path, "", "", u.fragment))
    except Exception:
        return href


def build_rich_description(
    description: str = "",
    *,
    experience: str = "",
    skills: str = "",
    posted: str = "",
    salary: str = "",
) -> Optional[str]:
    """Concatenate a job's description with the structured fields (experience,
    skills, posted-when, salary) that sites show next to the listing.

    Why this matters: the match-score pipeline in `lib/scoring.ts` keyword-
    matches against the `description` field. The more relevant signal we cram
    in there, the better the scoring — skills tags from `ul.tags-gt li` on
    Naukri, for example, are often the cleanest source of "what tech this
    role needs" anywhere on the page.

    Returns None (not "") when nothing was captured, so the ingest endpoint
    sees a clean SQL NULL rather than a row of empty descriptions.
    """
    parts: list[str] = []
    if description:
        parts.append(description.strip())
    if experience:
        parts.append(f"Experience: {experience.strip()}")
    if skills:
        parts.append(f"Skills: {skills.strip()}")
    if salary:
        parts.append(f"Salary: {salary.strip()}")
    if posted:
        parts.append(f"Posted: {posted.strip()}")
    if not parts:
        return None
    return " | ".join(parts)


async def collect_tag_texts(card, root_selector: str, item_selector: str = "li") -> str:
    """Find a tag container (e.g. `ul.tags-gt`) and return its child labels as
    a comma-joined string. Returns '' if the container or items are absent.
    Used by every scraper that exposes a skills/tags list."""
    try:
        root = await card.query_selector(root_selector)
        if not root:
            return ""
        items = await root.query_selector_all(item_selector)
        texts: list[str] = []
        for it in items:
            try:
                t = (await it.inner_text() or "").strip()
                if t:
                    texts.append(t)
            except Exception:
                continue
        return ", ".join(texts)
    except Exception:
        return ""


def looks_like_target_role(title: str) -> bool:
    """Pre-filter used by generic fallback paths. The orchestrator
    (`main.py::classify_role`) does the authoritative filtering, so this is
    intentionally generous — better to feed a slightly-too-broad list to the
    central filter than to drop a real match here."""
    if not title:
        return False
    t = title.lower()
    return any(kw in t for kw in (
        "product manager", "product mgr", "associate product", "apm",
        "project manager", "program manager",
        "business analyst", " ba ",
        "product owner",
    ))
