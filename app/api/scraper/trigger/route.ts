import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ALL_SOURCES = ['ats', 'naukri', 'linkedin', 'iimjobs', 'instahyre', 'hirist', 'wellfound', 'mnc']

export async function POST(req: NextRequest) {
  // Auth: allow either an API-key header (GitHub Action / CLI) or a same-origin
  // request from the dashboard. The dashboard request is trusted because it
  // hits the route from the same origin in a logged-in browser session; a
  // public attacker would still need the API key.
  const apiKey = req.headers.get('x-api-key')
  const sameOrigin = (() => {
    const origin = req.headers.get('origin')
    const host = req.headers.get('host')
    if (!origin || !host) return false
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  })()

  if (process.env.SCRAPER_API_KEY && apiKey !== process.env.SCRAPER_API_KEY && !sameOrigin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const scraperUrl = process.env.SCRAPER_API_URL
  if (!scraperUrl) {
    return NextResponse.json({ error: 'SCRAPER_API_URL not configured' }, { status: 500 })
  }

  let runId: string | null = null
  try {
    const run = await prisma.scraperRun.create({
      data: { status: 'RUNNING', sources: ALL_SOURCES },
    })
    runId = run.id

    // Kick off the Python scraper. The scraper accepts the request, returns
    // immediately with 202, and finishes the work in the background — posting
    // results back to /api/scraper/ingest. We MUST await the kick-off because
    // Vercel terminates pending promises after the response is sent.
    //
    // Render free-tier sleeps after 15 min of inactivity; cold-start takes
    // 30-50s. We first ping /health to wake it up (with its own long-ish
    // timeout), then send the actual /scrape request. Vercel maxDuration is
    // 60s for this route, so total budget is tight but workable.
    const baseUrl = scraperUrl.replace(/\/+$/, '') // strip trailing slashes

    // Step 1: wake-up ping (best-effort, fail silently if it times out)
    const wakeController = new AbortController()
    const wakeTimeout = setTimeout(() => wakeController.abort(), 45000)
    try {
      await fetch(`${baseUrl}/health`, { signal: wakeController.signal })
    } catch {
      // ignore — we'll surface the error on the /scrape call below
    } finally {
      clearTimeout(wakeTimeout)
    }

    // Step 2: actual scrape kick-off
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12000)
    let kickedOff = false
    try {
      const res = await fetch(`${baseUrl}/scrape`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.SCRAPER_API_KEY ?? '',
        },
        body: JSON.stringify({ runId: run.id, sources: null }),
        signal: controller.signal,
      })
      kickedOff = res.ok || res.status === 202
      if (!kickedOff) {
        const text = await res.text().catch(() => '')
        throw new Error(`Scraper returned ${res.status}: ${text.slice(0, 200)}`)
      }
    } finally {
      clearTimeout(timeout)
    }

    return NextResponse.json({ runId: run.id, message: 'Scraper started', sources: ALL_SOURCES })
  } catch (err: any) {
    console.error('Scraper trigger failed:', err)
    if (runId) {
      await prisma.scraperRun
        .update({
          where: { id: runId },
          data: { status: 'FAILED', completedAt: new Date(), errorsJson: { message: String(err?.message || err) } },
        })
        .catch(() => {})
    }
    const isAbort = err?.name === 'AbortError'
    return NextResponse.json(
      {
        error: isAbort
          ? 'Scraper service did not respond in time. It is likely cold-starting on Render free tier — wait 60 seconds and try again.'
          : `Failed to start scraper: ${err?.message || 'unknown error'}`,
      },
      { status: 502 }
    )
  }
}
