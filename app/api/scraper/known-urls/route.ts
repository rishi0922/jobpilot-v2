import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Returns the set of sourceUrls already in the database so the Python scraper
 * service can skip jobs it has already seen — avoiding the wasted work of
 * re-parsing, re-scoring, and re-upserting tens of thousands of identical
 * rows on every cron run.
 *
 * Query params:
 *   ?source=naukri    — only return URLs for a specific source (optional)
 *   ?days=30          — only return URLs scraped in the last N days (optional)
 *
 * Auth: same x-api-key header used by /scrape and /ingest.
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

    const where: any = {}
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
