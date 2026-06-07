# JobPilot — Setup & Deployment Guide

## What this is
A fully automated job scraping + application tool for PM, APM, Project Manager,
Program Manager, and Business Analyst roles in Indian IT. Built with:
- **Frontend**: Next.js 14 on Vercel (free)
- **Database**: Neon PostgreSQL (free, India-accessible)
- **Scraper**: Python + Playwright on Render.com (free)
- **Scheduler**: GitHub Actions (free, runs every 3 hours)
- **CV Analysis**: Google Gemini 2.0 Flash (free tier — 1M tokens/day)

---

## Step 1 — Neon database setup

1. Go to https://neon.tech and create a free account
2. Create a new project called `jobpilot`
3. Copy the **connection string** — looks like:
   `postgresql://user:pass@ep-xxx.ap-southeast-1.aws.neon.tech/jobpilot?sslmode=require`
4. Save it — you'll need it in Step 3

---

## Step 2 — Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/jobpilot.git
cd jobpilot
npm install
```

---

## Step 3 — Configure environment

```bash
cp .env.template .env.local
```

Edit `.env.local` and fill in:

```
DATABASE_URL=              # from Step 1
NEXTAUTH_SECRET=           # run: openssl rand -base64 32
NEXTAUTH_URL=              # http://localhost:3000 locally, your Vercel URL in prod
GEMINI_API_KEY=            # from aistudio.google.com/apikey (free)
CREDENTIAL_ENCRYPTION_KEY= # any 32-character string
SCRAPER_API_KEY=           # make up a long random string
GOOGLE_CLIENT_ID=          # OPTIONAL — enables 'Sign in with Google' button
GOOGLE_CLIENT_SECRET=      # OPTIONAL — get from console.cloud.google.com
```

## Multi-user note (post v2)

JobPilot is multi-tenant — every user has their own CVs, jobs, profile,
credentials and scraper runs. New users sign up at `/signup` but their
email must be in `EmailAllowlist` first. Unlisted emails are redirected
to `/waitlist` where they request access. Admins promote requests via
the `/admin` page.

**Bootstrap (first user):**
1. Run `npm run db:push` so the new tables exist.
2. Run the migration: `npx tsx scripts/migrate-to-multiuser.ts`
   with `FIRST_USER_EMAIL`, `FIRST_USER_PASSWORD`, `FIRST_USER_NAME` env vars.
   This creates a User row with role=ADMIN, allowlists you, and attaches
   any pre-existing jobs/CVs/credentials/profile to your account.
3. Sign in at `/signin`. You'll see a shield icon in the header — that's
   `/admin` where you manage the allowlist and waitlist.

---

## Step 4 — Push database schema

```bash
npm run db:push
```

This creates all tables in Neon automatically.

---

## Step 5 — Deploy frontend to Vercel

1. Push your repo to GitHub
2. Go to https://vercel.com → New Project → Import your repo
3. Add all environment variables from `.env.local` in Vercel dashboard
4. Deploy — your dashboard will be live at `https://jobpilot-xxx.vercel.app`

---

## Step 6 — Deploy Python scraper to Render

1. Go to https://render.com → New Web Service
2. Connect your GitHub repo
3. Set **Root Directory** to `scripts`
4. Set **Build Command**: `pip install -r requirements.txt && playwright install chromium && playwright install-deps chromium`
5. Set **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
6. Add environment variables:
   - `SCRAPER_API_KEY` = same value as in your `.env.local`
   - `NEXT_APP_URL` = your Vercel URL (e.g. `https://jobpilot-xxx.vercel.app`)
7. Deploy — note the Render URL (e.g. `https://jobpilot-scraper.onrender.com`)
8. Update `SCRAPER_API_URL` in Vercel with this Render URL

---

## Step 7 — Set up GitHub Actions scheduler

1. In your GitHub repo → Settings → Secrets → Actions
2. Add:
   - `NEXT_APP_URL` = your Vercel URL
   - `SCRAPER_API_KEY` = your scraper API key
3. The workflow at `.github/workflows/scraper-cron.yml` will run automatically
4. To test manually: Actions tab → "JobPilot Scraper" → Run workflow

---

## Step 8 — Add your credentials via the app

1. Open your dashboard at your Vercel URL
2. Go to **Settings → Site credentials**
3. Enter credentials for each site:
   - Naukri: rishi3.work@gmail.com
   - LinkedIn: rishi3.work@gmail.com
   - Instahyre: rishi3.work@gmail.com
   - IIMJobs: (add when ready)
4. Click **Save encrypted** — passwords are AES-256 encrypted, never stored in plain text

---

## Step 9 — Upload your CVs

1. Go to **Settings → CV files**
2. Upload a PDF for each role:
   - APM CV
   - PM CV
   - Project Manager CV
   - Program Manager CV
   - Business Analyst CV
3. The system auto-selects the right CV per job

---

## Step 10 — First scrape run

1. On the dashboard, click **Run scraper**
2. Wait ~3-5 minutes for first results
3. Jobs will appear in the Jobs tab
4. In Auto mode — they apply automatically
5. In Manual mode — approve each batch with the Apply/Skip buttons

---

## Auto/Manual toggle

- **Auto mode**: Every scraped job that passes your minimum match score is queued
  and applied to without any intervention needed.
- **Manual mode**: Jobs land in a review queue. You see each job, its AI match score,
  and choose Apply or Skip.

Switch anytime using the toggle in the top nav bar.

---

## CV Analysis

### Pre-application scoring
Paste any job description into Settings → CV Analysis.
Gemini scores your CV against it and tells you:
- Match score (0–100)
- Strengths that align
- Gaps to address
- Missing keywords to add

### Post-application insights
After 50+ applications, the system analyses your outcomes and tells you:
- Which role types are converting to interviews
- Which job boards perform best for you
- Specific CV changes that will improve callback rate

---

## Personal info to update before first run

Open `scripts/applicator.py` and update the `COMMON_FIELD_MAP` dictionary:

```python
COMMON_FIELD_MAP = {
    "name":          "YOUR_FIRST_NAME",
    "full_name":     "YOUR_FULL_NAME",
    "email":         "rishi3.work@gmail.com",
    "phone":         "YOUR_10_DIGIT_MOBILE",   # <-- ADD THIS
    "mobile":        "YOUR_10_DIGIT_MOBILE",   # <-- ADD THIS
    "current_ctc":   "YOUR_CURRENT_CTC",       # <-- ADD THIS
    "expected_ctc":  "YOUR_EXPECTED_CTC",      # <-- ADD THIS
    "notice_period": "Immediate",
    "experience":    "YOUR_YEARS_EXP",         # <-- ADD THIS
    ...
}
```

---

## Free tier limits

| Service | Free tier limit | Notes |
|---------|----------------|-------|
| Vercel | Unlimited deploys | 100GB bandwidth/mo |
| Neon | 3GB storage | More than enough |
| Render | 750 hrs/mo | Spins down after 15min idle |
| GitHub Actions | 2000 min/mo | ~66 scraper runs/mo |
| Google Gemini | Free tier: 1M input tokens/day | ~300-500 CV analyses/day on free tier |

---

## Troubleshooting

**Scraper returns 0 jobs**: Render free tier spins down — first request takes 30-60s.
Click Run scraper twice if needed.

**Login failing on sites**: Some sites add CAPTCHA after multiple logins. Use the
manual mode for those sites, or add a delay in the scraper config.

**Neon connection timeout**: Neon free tier also has a spin-up delay. First query
of the day may take 3-5 seconds.

**LinkedIn blocking**: LinkedIn rate-limits scrapers aggressively. If blocked, the
scraper automatically skips and retries on the next run.

---

## Architecture summary

```
GitHub Actions (cron)
       ↓ POST /api/scraper/trigger
Next.js on Vercel
       ↓ POST /scrape  
Python scraper on Render
  → Playwright scrapes all sources
  → POST /api/scraper/ingest back to Next.js
       ↓
Neon PostgreSQL (jobs saved)
       ↓ (AUTO mode)
Applicator queue
  → Python fills & submits forms per site
  → Status updated in DB
       ↓
Dashboard (real-time from DB)
```
