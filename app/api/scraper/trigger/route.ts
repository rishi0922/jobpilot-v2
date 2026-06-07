import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { getCurrentUserId, resolveScraperUserId } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ALL_SOURCES = ['ats', 'naukri', 'linkedin', 'iimjobs', 'instahyre', 'hirist', 'wellfound', 'mnc']

/**
 * Trigger a scrape for the current user (when called from the dashboard) or
 * a specified user (when called by the cron with an API key).
 *
 * Two auth modes — same as before but now they resolve a userId:
 *   1. Same-origin browser session → use NextAuth session userId.
 *   2. x-api-key header (cron / Render) → expect userId in body, else fall
 *      back to first admin user.
 *
 * The scrape is then per-user: cleanup, ScraperRun row, and the Python
 * /scrape payload all carry the userId so the rest of the chain stays
 * scoped to that user.
 */
export async function POST(req: NextRequest) {
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

  // ── Auth + userId resolution ────────────────────────────────────────────
  let userId: string | null = null
  if (sameOrigin) {
    // Browser request — require a valid session
    userId = await getCurrentUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  } else {
    // Non-browser caller — require api key
    if (!process.env.SCRAPER_API_KEY || apiKey !== process.env.SCRAPER_API_KEY) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const body = await req.clone().json().catch(() => ({}))
    userId = await resolveScraperUserId(body)
    if (!userId) {
      return NextResponse.json({ error: 'No users in system' }, { status: 503 })
    }
  }

  const scraperUrl = process.env.SCRAPER_API_URL
  if (!scraperUrl) {
    return NextResponse.json({ error: 'SCRAPER_API_URL not configured' }, { status: 500 })
  }

  // Cleanup: delete this user's stale FOUND/QUEUED/SKIPPED jobs (>7 days
  // without a touch). Scoped by userId so one user's cleanup never touches
  // another user's data.
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const deleted = await prisma.job.deleteMany({
      where: {
        userId,
        lastUpdated: { lt: cutoff },
        status: { in: ['FOUND', 'QUEUED', 'SKIPPED'] },
      },
    })
    if (deleted.count > 0) {
      console.log(`[trigger:${userId}] cleanup: removed ${deleted.count} stale jobs`)
    }
  } catch (e) {
    console.error('[trigger] cleanup failed:', e)
  }

  // Per-user search queries — if the user has any in their profile, pass
  // them to the Python scraper; it'll fall back to its own SEARCH_QUERIES
  // default when the list is empty.
  const userProfile = await prisma.profile.findUnique({
    where:  { userId },
    select: { searchQueries: true },
  }).catch(() => null)
  const queries = userProfile?.searchQueries ?? []

  let runId: string | null = null
  try {
    const run = await prisma.scraperRun.create({
      data: { userId, status: 'RUNNING', sources: ALL_SOURCES },
    })
    runId = run.id

    const baseUrl = scraperUrl.replace(/\/+$/, '')

    // Step 1: wake-up ping
    const wakeController = new AbortController()
    const wakeTimeout = setTimeout(() => wakeController.abort(), 45000)
    try {
      await fetch(`${baseUrl}/health`, { signal: wakeController.signal })
    } catch {
      // ignore
    } finally {
      clearTimeout(wakeTimeout)
    }

    // Step 2: scrape kick-off. Pass userId in the body so main.py can
    // forward it to /ingest, /known-urls, /touch-seen, etc.
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
        body: JSON.stringify({ runId: run.id, sources: null, userId, queries }),
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
