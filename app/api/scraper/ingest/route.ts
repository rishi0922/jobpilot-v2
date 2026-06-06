import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { qualityGateReason, scoreJob, type ScoringProfile } from '@/lib/scoring'
import { resolveScraperUserId } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

async function loadScoringProfile(userId: string): Promise<ScoringProfile | null> {
  const p = await prisma.profile.findUnique({ where: { userId } }).catch(() => null)
  if (!p) return null
  return {
    yearsExperience:    p.yearsExperience,
    skills:             p.skills || [],
    preferredLocations: p.preferredLocations || [],
    preferredIndustries: p.preferredIndustries || [],
    remoteOnly:         !!p.remoteOnly,
  }
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('x-api-key')
  if (apiKey !== process.env.SCRAPER_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { jobs, runId } = body

    // Resolve the owning user. Body can specify userId explicitly (preferred,
    // Commit 4 will make main.py do this); falls back to first admin user for
    // backward compat with the current single-user Python scraper.
    const userId = await resolveScraperUserId(body)
    if (!userId) {
      return NextResponse.json({ error: 'No users in system' }, { status: 503 })
    }

    if (!jobs?.length) {
      // Empty payload still updates the run as completed (end-of-scrape signal)
      if (runId) {
        await prisma.scraperRun.updateMany({
          where: { id: runId, userId },
          data:  { status: 'COMPLETED', completedAt: new Date() },
        })
      }
      return NextResponse.json({ saved: 0 })
    }

    const applyMode    = process.env.DEFAULT_APPLY_MODE === 'MANUAL' ? 'MANUAL' : 'AUTO'
    const minAutoScore = await getMinAutoApplyScore(userId)
    const profile      = await loadScoringProfile(userId)

    let saved          = 0
    let skipped        = 0
    let droppedQuality = 0
    const dropReasons: Record<string, number> = {}

    for (const job of jobs) {
      // Pre-storage quality gate
      const qReason = qualityGateReason({
        title:       job.title,
        company:     job.company,
        description: job.description || null,
        postedAt:    job.postedAt ? new Date(job.postedAt) : null,
        sourceUrl:   job.sourceUrl,
      })
      if (qReason) {
        droppedQuality++
        dropReasons[qReason] = (dropReasons[qReason] || 0) + 1
        continue
      }

      // Compute deterministic match score + breakdown
      const { score, reasons, notes } = scoreJob(
        {
          title:       job.title,
          company:     job.company,
          location:    job.location || null,
          description: job.description || null,
          roleType:    job.roleType || 'PM',
          source:      job.source,
        },
        profile
      )

      // AUTO-mode jobs only enter the apply queue if they meet the score
      // threshold; lower-scored jobs go to FOUND so the user can review.
      const initialStatus = applyMode === 'AUTO'
        ? (score >= minAutoScore ? 'QUEUED' : 'FOUND')
        : 'FOUND'

      try {
        await prisma.job.upsert({
          where:  { userId_sourceUrl: { userId, sourceUrl: job.sourceUrl } },
          update: {
            lastUpdated:  new Date(),
            // Refresh scoring on re-scrape (description may have updated, profile may have changed)
            matchScore:   score,
            matchNotes:   notes,
            matchReasons: reasons as any,
          },
          create: {
            userId,
            title:        job.title,
            company:      job.company,
            location:     job.location || null,
            description:  job.description || null,
            sourceUrl:    job.sourceUrl,
            source:       job.source,
            roleType:     job.roleType || 'PM',
            salary:       job.salary || null,
            postedAt:     job.postedAt ? new Date(job.postedAt) : null,
            status:       initialStatus as any,
            applyMode:    applyMode as any,
            matchScore:   score,
            matchNotes:   notes,
            matchReasons: reasons as any,
          },
        })
        saved++
      } catch (e: any) {
        if (e.code === 'P2002') { skipped++; continue } // unique constraint
        throw e
      }
    }

    // Roll up per-source stats so the dashboard can show source-health.
    if (runId && jobs.length > 0) {
      await mergeSourceStats(runId, jobs[0].source, {
        found:     jobs.length,
        kept:      saved,
        skipped:   skipped,
        dropped:   droppedQuality,
        reasons:   dropReasons,
      })
      await prisma.scraperRun.update({
        where: { id: runId },
        data: { jobsFound: { increment: saved } },
      })
    } else if (!runId) {
      await prisma.scraperRun.updateMany({
        where: { userId, status: 'RUNNING' },
        data: { jobsFound: { increment: saved } },
      })
    }

    if (droppedQuality > 0) {
      console.log(`[ingest] dropped ${droppedQuality} jobs by quality gate:`, dropReasons)
    }

    // Trigger applicator for AUTO mode jobs (only those that scored above threshold)
    if (applyMode === 'AUTO') {
      void processQueue(userId)
    }

    return NextResponse.json({ saved, skipped, droppedQuality, total: jobs.length })
  } catch (err: any) {
    console.error('Ingest error:', err)
    return NextResponse.json({ error: err?.message || 'Ingest failed' }, { status: 500 })
  }
}

async function getMinAutoApplyScore(userId: string): Promise<number> {
  const p = await prisma.profile.findUnique({ where: { userId } }).catch(() => null)
  return p?.minMatchScore ?? 60
}

async function mergeSourceStats(runId: string, source: string, stats: any) {
  // Read-modify-write of the JSON column. ScraperRun has a sourceStats JSON
  // map keyed by source name; we merge in this batch's numbers.
  try {
    const run = await prisma.scraperRun.findUnique({ where: { id: runId } })
    if (!run) return
    const cur = ((run.sourceStats as any) || {}) as Record<string, any>
    const prev = cur[source] || { found: 0, kept: 0, skipped: 0, dropped: 0, reasons: {} }
    cur[source] = {
      found:   (prev.found   || 0) + (stats.found   || 0),
      kept:    (prev.kept    || 0) + (stats.kept    || 0),
      skipped: (prev.skipped || 0) + (stats.skipped || 0),
      dropped: (prev.dropped || 0) + (stats.dropped || 0),
      reasons: mergeReasons(prev.reasons || {}, stats.reasons || {}),
    }
    await prisma.scraperRun.update({
      where: { id: runId },
      data:  { sourceStats: cur as any },
    })
  } catch (e) {
    console.error('mergeSourceStats failed:', e)
  }
}

function mergeReasons(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] || 0) + (v || 0)
  return out
}

async function processQueue(userId: string) {
  const scraperUrl = process.env.SCRAPER_API_URL
  if (!scraperUrl) {
    console.log('[apply-queue] SCRAPER_API_URL not set — skipping auto-apply')
    return
  }

  const queued = await prisma.job.findMany({
    where: { userId, status: 'QUEUED', applyMode: 'AUTO' },
    take: 20,
    orderBy: { scrapedAt: 'asc' },
  })

  console.log(`[apply-queue:${userId}] ${queued.length} jobs to apply`)

  let applied = 0
  let failedNoCv = 0
  let failedApi = 0

  for (const job of queued) {
    try {
      // Get the right CV for this role type (user-scoped)
      const cv = await prisma.cV.findUnique({
        where: { userId_roleType: { userId, roleType: job.roleType as any } },
      })
      if (!cv) {
        console.log(`[apply-queue] job ${job.id}: no CV uploaded for roleType=${job.roleType} — marking FAILED`)
        await prisma.job.update({
          where: { id: job.id },
          data: { status: 'FAILED', matchNotes: `Auto-apply failed: no CV uploaded for role ${job.roleType}` },
        }).catch(() => {})
        failedNoCv++
        continue
      }

      // Get credentials for this source (user-scoped)
      const cred = await prisma.credential.findUnique({
        where: { userId_siteName: { userId, siteName: capitalise(job.source) } },
      })
      if (!cred) {
        console.log(`[apply-queue] job ${job.id}: no credentials for ${capitalise(job.source)} — applying without login`)
      }

      const { decrypt } = await import('@/lib/crypto')
      const credentials = cred ? { username: cred.username, password: decrypt(cred.passwordEnc) } : {}

      const res = await fetch(`${scraperUrl}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.SCRAPER_API_KEY! },
        body: JSON.stringify({
          jobId: job.id, sourceUrl: job.sourceUrl, source: job.source,
          roleType: job.roleType, cvUrl: cv.fileUrl, credentials,
        }),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        console.log(`[apply-queue] job ${job.id}: /apply returned ${res.status}: ${text.slice(0, 200)}`)
        await prisma.job.update({
          where: { id: job.id },
          data: { status: 'FAILED', matchNotes: `Apply API ${res.status}: ${text.slice(0, 200)}` },
        }).catch(() => {})
        failedApi++
        continue
      }

      const result = await res.json().catch(() => ({ success: false, message: 'invalid JSON from /apply' }))
      const success = !!result.success
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status:     success ? 'APPLIED' : 'FAILED',
          appliedAt:  success ? new Date() : undefined,
          cvUsed:     job.roleType,
          matchNotes: result.message ? String(result.message).slice(0, 500) : null,
        },
      })
      if (success) applied++
      else failedApi++
    } catch (e: any) {
      console.error(`[apply-queue] job ${job.id} unexpected error:`, e?.message || e)
      await prisma.job.update({
        where: { id: job.id },
        data: { status: 'FAILED', matchNotes: `Unexpected: ${(e?.message || 'unknown').slice(0, 500)}` },
      }).catch(() => {})
      failedApi++
    }
  }

  console.log(`[apply-queue:${userId}] done — applied=${applied}, failed-no-cv=${failedNoCv}, failed-api=${failedApi}`)
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}
