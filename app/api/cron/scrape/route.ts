import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Vercel Cron entrypoint: triggered daily by the schedule declared in
 * vercel.json (`0 2 * * *` = 2:00 AM UTC = 7:30 AM IST). Vercel hits this
 * endpoint with `Authorization: Bearer <CRON_SECRET>` so no one else can
 * trigger it from outside.
 *
 * Multi-user behaviour:
 *   - Iterates every USER (not just admin) in the DB and POSTs to
 *     /api/scraper/trigger for each, passing the userId.
 *   - Sequential so we don't overwhelm Render's 512 MB / single-instance
 *     scraper. If you scale past ~20 daily users you'll want a queue (e.g.
 *     Vercel KV) and batching.
 *   - A failed trigger for one user doesn't stop the others.
 */
export async function GET(req: NextRequest) {
  // Vercel-only: when CRON_SECRET is set, Vercel auto-attaches it to
  // cron-triggered requests as Authorization: Bearer <secret>.
  const authHeader = req.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Resolve the public origin for the internal POST
  const origin =
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` :
    process.env.NEXTAUTH_URL ? process.env.NEXTAUTH_URL :
    'http://localhost:3000'

  // Iterate every user. (Could later add a `scrapeEnabled` flag on Profile
  // to let users opt out of the daily auto-scrape.)
  const users = await prisma.user.findMany({
    select: { id: true, email: true },
  })

  const results: Array<{ userId: string; email: string; ok: boolean; error?: string }> = []
  for (const user of users) {
    try {
      const res = await fetch(`${origin}/api/scraper/trigger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key':    process.env.SCRAPER_API_KEY ?? '',
        },
        body: JSON.stringify({ userId: user.id }),
      })

      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        console.error(`[cron:scrape:${user.email}] trigger failed:`, res.status, body)
        results.push({ userId: user.id, email: user.email, ok: false, error: `${res.status}: ${JSON.stringify(body)}` })
        continue
      }
      console.log(`[cron:scrape:${user.email}] kicked off`)
      results.push({ userId: user.id, email: user.email, ok: true })
    } catch (err: any) {
      console.error(`[cron:scrape:${user.email}] error:`, err)
      results.push({ userId: user.id, email: user.email, ok: false, error: err?.message || 'unknown' })
    }
  }

  return NextResponse.json({
    triggeredAt: new Date().toISOString(),
    totalUsers:  users.length,
    succeeded:   results.filter(r => r.ok).length,
    failed:      results.filter(r => !r.ok).length,
    results,
  })
}
