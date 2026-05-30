import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Bump `lastUpdated` on every Job whose sourceUrl was re-found in the current
 * scrape run, even when the scraper dropped it as "already known" before
 * sending to /ingest.
 *
 * Why this exists: scripts/main.py seeds its in-memory dedup set with
 * URLs already in the DB (see /api/scraper/known-urls). That makes the
 * scraper fast — it skips re-processing 300+ known jobs every run — but
 * it also means those jobs never reach /ingest, so their `lastUpdated`
 * stays stale. With a 7-day auto-cleanup based on lastUpdated, those
 * still-active jobs would get incorrectly deleted on the next trigger.
 *
 * Solution: scraper sends the list of re-found URLs here in a single
 * batch, we update them all with a single `updateMany`. Single SQL
 * statement, no N+1.
 *
 * Auth: same x-api-key as /scrape and /ingest.
 */
export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('x-api-key')
  if (apiKey !== process.env.SCRAPER_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { urls } = await req.json()
    if (!Array.isArray(urls) || urls.length === 0) {
      return NextResponse.json({ touched: 0 })
    }

    const res = await prisma.job.updateMany({
      where: { sourceUrl: { in: urls } },
      data:  { lastUpdated: new Date() },
    })

    return NextResponse.json({ touched: res.count })
  } catch (err: any) {
    console.error('touch-seen error:', err)
    return NextResponse.json({ error: err?.message || 'Touch failed' }, { status: 500 })
  }
}
