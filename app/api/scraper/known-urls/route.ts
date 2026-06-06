import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { resolveScraperUserId } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Returns the set of sourceUrls already in the database (for a specific
 * user) so the Python scraper can skip jobs it has already seen.
 *
 * Query params:
 *   ?userId=<id>     — which user's dedup set (passed by Commit 4 main.py)
 *   ?source=naukri   — only return URLs for a specific source
 *   ?days=30         — only return URLs scraped in the last N days
 *
 * Auth: same x-api-key header used by /scrape and /ingest.
 *
 * Multi-user note: returns only URLs the requesting userId already has.
 * Without userId in the query, falls back to the first admin user
 * (transitional — Commit 4 will make main.py always pass userId).
 */
export async function GET(req: NextRequest) {
  const apiKey = req.headers.get('x-api-key')
  if (apiKey !== process.env.SCRAPER_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const url    = new URL(req.url)
    const source = url.searchParams.get('source') || undefined
    const days   = url.searchParams.get('days')

    const userId = await resolveScraperUserId(undefined, url)
    if (!userId) {
      return NextResponse.json({ error: 'No users in system' }, { status: 503 })
    }

    const where: any = { userId }
    if (source) where.source = source
    if (days && !Number.isNaN(Number(days))) {
      const cutoff = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000)
      where.scrapedAt = { gte: cutoff }
    }

    const rows = await prisma.job.findMany({
      where,
      select: { sourceUrl: true },
    })

    return NextResponse.json({
      urls:  rows.map(r => r.sourceUrl),
      count: rows.length,
    })
  } catch (err: any) {
    console.error('known-urls error:', err)
    return NextResponse.json({ error: err?.message || 'Lookup failed' }, { status: 500 })
  }
}
