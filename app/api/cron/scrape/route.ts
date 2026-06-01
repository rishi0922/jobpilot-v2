import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Vercel Cron entrypoint: triggered daily by the schedule declared in
 * vercel.json (`0 2 * * *` = 2:00 AM UTC = 7:30 AM IST). Vercel hits this
 * endpoint with `Authorization: Bearer <CRON_SECRET>` so no one else can
 * trigger it from outside.
 *
 * The cron job just POSTs to /api/scraper/trigger with the same x-api-key
 * we already use for manual/render-side calls, so the actual kickoff logic
 * (DB cleanup of 7-day-old jobs + Render wake-up + scrape POST) stays in
 * exactly one place.
 *
 * To change the schedule: edit `crons[].schedule` in vercel.json and redeploy.
 * To pause: remove the entry from vercel.json (or comment out — Vercel will
 * delete the cron on next deploy).
 */
export async function GET(req: NextRequest) {
  // Vercel-only: when CRON_SECRET is set, Vercel auto-attaches it to
  // cron-triggered requests as Authorization: Bearer <secret>. Any other
  // caller will be 401'd.
  const authHeader = req.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Build a same-origin absolute URL for the internal POST. Vercel's edge
  // automatically injects VERCEL_URL on every deployment; for local dev
  // we fall back to NEXTAUTH_URL or localhost.
  const origin =
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` :
    process.env.NEXTAUTH_URL ? process.env.NEXTAUTH_URL :
    'http://localhost:3000'

  try {
    const res = await fetch(`${origin}/api/scraper/trigger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    process.env.SCRAPER_API_KEY ?? '',
      },
      body: JSON.stringify({}),
    })

    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.error('[cron:scrape] trigger failed:', res.status, body)
      return NextResponse.json(
        { error: `Trigger returned ${res.status}`, details: body },
        { status: 502 }
      )
    }

    console.log('[cron:scrape] kicked off scrape:', body)
    return NextResponse.json({ ok: true, ...body, triggeredAt: new Date().toISOString() })
  } catch (err: any) {
    console.error('[cron:scrape] error:', err)
    return NextResponse.json(
      { error: err?.message || 'Cron scrape failed' },
      { status: 500 }
    )
  }
}
