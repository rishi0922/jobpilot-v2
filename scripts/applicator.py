"""
Auto-applicator — fills and submits application forms.
Uses Playwright to navigate each site's apply flow.
Downloads the correct CV PDF, attaches it, fills standard fields.
"""

import asyncio
import os
import tempfile
from datetime import datetime
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout
import httpx

COMMON_FIELD_MAP = {
    # Maps common field names/labels → placeholder values
    # These are overridden per-site below
    "name":          "Rishi",
    "full_name":     "Rishi",
    "email":         "rishi3.work@gmail.com",
    "phone":         "",   # fill in before deploy
    "mobile":        "",
    "current_ctc":   "0",
    "expected_ctc":  "0",
    "notice_period": "Immediate",
    "experience":    "2",
    "cover_letter":  "I am highly interested in this role and believe my product management background makes me a strong fit.",
}

async def apply_to_job(
    source: str,
    url: str,
    cv_url: str,
    credentials: dict,
    role_type: str = "PM",
) -> dict:
    """
    Main entry point. Routes to the correct apply handler per source.
    Returns {"success": bool, "message": str, "appliedAt": iso_string}
    """
    handler_map = {
        "naukri":    _apply_naukri,
        "linkedin":  _apply_linkedin,
        "iimjobs":   _apply_iimjobs,
        "instahyre": _apply_instahyre,
        "hirist":    _apply_generic,
        "wellfound": _apply_generic,
        "mnc":       _apply_generic,
    }
    handler = handler_map.get(source.lower(), _apply_generic)

    try:
        cv_path = await _download_cv(cv_url)
        result  = await handler(url, credentials, cv_path, role_type)
        if os.path.exists(cv_path):
            os.remove(cv_path)
        return result
    except Exception as e:
        return {"success": False, "message": str(e), "appliedAt": None}


async def _download_cv(cv_url: str) -> str:
    """Download CV PDF to temp file. Returns local path."""
    async with httpx.AsyncClient() as client:
        r = await client.get(cv_url, timeout=30)
        r.raise_for_status()
    suffix = ".pdf"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp.write(r.content)
    tmp.close()
    return tmp.name


async def _apply_naukri(url: str, creds: dict, cv_path: str, role_type: str) -> dict:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )
        page = await context.new_page()
        try:
            # Login
            await page.goto("https://www.naukri.com/nlogin/login", wait_until="domcontentloaded", timeout=20000)
            await page.wait_for_timeout(1500)
            await page.fill('input[placeholder*="Email"]', creds.get("username", ""))
            await page.fill('input[placeholder*="password"]', creds.get("password", ""))
            await page.click('button[type="submit"]')
            await page.wait_for_timeout(3000)

            # Navigate to job
            await page.goto(url, wait_until="domcontentloaded", timeout=25000)
            await page.wait_for_timeout(2000)

            # Click Apply
            apply_btn = await page.query_selector('button#apply-button, a#apply-button, button[data-ga-track*="apply"]')
            if not apply_btn:
                apply_btn = await page.query_selector('button:has-text("Apply"), a:has-text("Apply now")')
            if apply_btn:
                await apply_btn.click()
                await page.wait_for_timeout(2000)

            # Handle modal / new tab
            pages = context.pages
            apply_page = pages[-1] if len(pages) > 1 else page

            # Attach CV if file input appears
            file_input = await apply_page.query_selector('input[type="file"]')
            if file_input:
                await file_input.set_input_files(cv_path)
                await apply_page.wait_for_timeout(1500)

            # Submit
            submit = await apply_page.query_selector('button[type="submit"], button:has-text("Submit"), button:has-text("Apply")')
            if submit:
                await submit.click()
                await apply_page.wait_for_timeout(2000)

            return {"success": True, "message": "Applied via Naukri", "appliedAt": datetime.utcnow().isoformat()}
        except Exception as e:
            return {"success": False, "message": f"Naukri apply failed: {e}", "appliedAt": None}
        finally:
            await browser.close()


async def _apply_linkedin(url: str, creds: dict, cv_path: str, role_type: str) -> dict:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )
        page = await context.new_page()
        try:
            # Login
            await page.goto("https://www.linkedin.com/login", wait_until="domcontentloaded", timeout=20000)
            await page.fill("#username", creds.get("username", ""))
            await page.fill("#password", creds.get("password", ""))
            await page.click('button[type="submit"]')
            await page.wait_for_timeout(4000)

            # Navigate to job
            await page.goto(url, wait_until="domcontentloaded", timeout=25000)
            await page.wait_for_timeout(2000)

            # Easy Apply button
            easy_apply = await page.query_selector('button.jobs-apply-button, button:has-text("Easy Apply")')
            if not easy_apply:
                return {"success": False, "message": "No Easy Apply button — external apply required", "appliedAt": None}

            await easy_apply.click()
            await page.wait_for_timeout(2000)

            # Multi-step form: handle up to 5 steps
            for step in range(5):
                # Upload CV if prompted
                file_input = await page.query_selector('input[type="file"][accept*="pdf"]')
                if file_input:
                    await file_input.set_input_files(cv_path)
                    await page.wait_for_timeout(1000)

                # Fill text fields
                await _fill_common_fields(page)

                # Try Next or Submit
                next_btn = await page.query_selector('button[aria-label="Continue to next step"], button:has-text("Next")')
                submit_btn = await page.query_selector('button[aria-label="Submit application"], button:has-text("Submit application")')

                if submit_btn:
                    await submit_btn.click()
                    await page.wait_for_timeout(2000)
                    return {"success": True, "message": "Applied via LinkedIn Easy Apply", "appliedAt": datetime.utcnow().isoformat()}
                elif next_btn:
                    await next_btn.click()
                    await page.wait_for_timeout(1500)
                else:
                    break

            return {"success": False, "message": "LinkedIn apply form did not complete", "appliedAt": None}
        except Exception as e:
            return {"success": False, "message": f"LinkedIn apply failed: {e}", "appliedAt": None}
        finally:
            await browser.close()


async def _apply_iimjobs(url: str, creds: dict, cv_path: str, role_type: str) -> dict:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )
        page = await context.new_page()
        try:
            await page.goto("https://www.iimjobs.com/candidate/login", wait_until="domcontentloaded", timeout=20000)
            await page.wait_for_timeout(1500)
            await page.fill('input[name="email"]', creds.get("username", ""))
            await page.fill('input[name="password"]', creds.get("password", ""))
            await page.click('button[type="submit"]')
            await page.wait_for_timeout(3000)

            await page.goto(url, wait_until="domcontentloaded", timeout=25000)
            await page.wait_for_timeout(2000)

            apply_btn = await page.query_selector('a.apply-btn, button:has-text("Apply"), a:has-text("Apply")')
            if apply_btn:
                await apply_btn.click()
                await page.wait_for_timeout(2000)

            await _fill_common_fields(page)

            file_input = await page.query_selector('input[type="file"]')
            if file_input:
                await file_input.set_input_files(cv_path)
                await page.wait_for_timeout(1000)

            submit = await page.query_selector('button[type="submit"], button:has-text("Submit")')
            if submit:
                await submit.click()
                await page.wait_for_timeout(2000)

            return {"success": True, "message": "Applied via IIMJobs", "appliedAt": datetime.utcnow().isoformat()}
        except Exception as e:
            return {"success": False, "message": f"IIMJobs apply failed: {e}", "appliedAt": None}
        finally:
            await browser.close()


async def _apply_instahyre(url: str, creds: dict, cv_path: str, role_type: str) -> dict:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )
        page = await context.new_page()
        try:
            await page.goto("https://www.instahyre.com/login/", wait_until="domcontentloaded", timeout=20000)
            await page.wait_for_timeout(1500)
            await page.fill('input[type="email"]', creds.get("username", ""))
            await page.fill('input[type="password"]', creds.get("password", ""))
            await page.click('button[type="submit"]')
            await page.wait_for_timeout(3000)

            await page.goto(url, wait_until="domcontentloaded", timeout=25000)
            await page.wait_for_timeout(2000)

            apply_btn = await page.query_selector('button.apply-btn, button:has-text("Apply"), a:has-text("Apply")')
            if apply_btn:
                await apply_btn.click()
                await page.wait_for_timeout(2000)

            file_input = await page.query_selector('input[type="file"]')
            if file_input:
                await file_input.set_input_files(cv_path)
                await page.wait_for_timeout(1000)

            submit = await page.query_selector('button[type="submit"], button:has-text("Submit")')
            if submit:
                await submit.click()
                await page.wait_for_timeout(2000)

            return {"success": True, "message": "Applied via Instahyre", "appliedAt": datetime.utcnow().isoformat()}
        except Exception as e:
            return {"success": False, "message": f"Instahyre apply failed: {e}", "appliedAt": None}
        finally:
            await browser.close()


async def _apply_generic(url: str, creds: dict, cv_path: str, role_type: str) -> dict:
    """
    Generic applicator used for Hirist, Wellfound, MNC sites.
    Tries common patterns: find Apply button → attach CV → fill fields → submit.
    """
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )
        page = await context.new_page()
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(2500)

            # Try to find Apply button
            for selector in [
                'button:has-text("Apply now")', 'button:has-text("Apply")',
                'a:has-text("Apply now")', 'a:has-text("Apply")',
                '[data-test="apply-button"]', '.apply-btn',
            ]:
                btn = await page.query_selector(selector)
                if btn:
                    await btn.click()
                    await page.wait_for_timeout(2000)
                    break

            # Fill fields
            await _fill_common_fields(page)

            # Attach CV
            file_input = await page.query_selector('input[type="file"]')
            if file_input:
                await file_input.set_input_files(cv_path)
                await page.wait_for_timeout(1000)

            # Submit
            for selector in ['button[type="submit"]', 'button:has-text("Submit")', 'input[type="submit"]']:
                submit = await page.query_selector(selector)
                if submit:
                    await submit.click()
                    await page.wait_for_timeout(2000)
                    break

            return {"success": True, "message": f"Applied via generic handler", "appliedAt": datetime.utcnow().isoformat()}
        except Exception as e:
            return {"success": False, "message": f"Generic apply failed: {e}", "appliedAt": None}
        finally:
            await browser.close()


async def _fill_common_fields(page):
    """Fill common form fields using label-based matching."""
    field_patterns = [
        ('input[name*="name"][name*="full"], input[placeholder*="full name"]', COMMON_FIELD_MAP["full_name"]),
        ('input[name*="first"][name*="name"], input[placeholder*="first name"]', COMMON_FIELD_MAP["name"]),
        ('input[type="email"], input[name*="email"]', COMMON_FIELD_MAP["email"]),
        ('input[name*="phone"], input[name*="mobile"], input[type="tel"]', COMMON_FIELD_MAP["phone"]),
        ('input[name*="ctc"], input[name*="salary"], input[placeholder*="current CTC"]', COMMON_FIELD_MAP["current_ctc"]),
        ('input[name*="expected"], input[placeholder*="expected"]', COMMON_FIELD_MAP["expected_ctc"]),
        ('input[name*="notice"], input[placeholder*="notice"]', COMMON_FIELD_MAP["notice_period"]),
        ('input[name*="experience"], input[placeholder*="experience"]', COMMON_FIELD_MAP["experience"]),
        ('textarea[name*="cover"], textarea[placeholder*="cover"]', COMMON_FIELD_MAP["cover_letter"]),
    ]
    for selector, value in field_patterns:
        try:
            el = await page.query_selector(selector)
            if el and value:
                await el.fill(value)
        except Exception:
            continue
