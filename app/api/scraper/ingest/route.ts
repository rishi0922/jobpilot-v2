import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('x-api-key')
  if (apiKey !== process.env.SCRAPER_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { jobs, runId } = await req.json()
    if (!jobs?.length) return NextResponse.json({ saved: 0 })

    const applyMode = process.env.DEFAULT_APPLY_MODE === 'MANUAL' ? 'MANUAL' : 'AUTO'

    // Upsert jobs - skip if URL already exists
    let saved = 0
    let skipped = 0

    for (const job of jobs) {
      try {
        await prisma.job.upsert({
          where:  { sourceUrl: job.sourceUrl },
          update: { lastUpdated: new Date() }, // already exists - just touch it
          create: {
            title:     job.title,
            company:   job.company,
            location:  job.location || null,
            sourceUrl: job.sourceUrl,
            source:    job.source,
            roleType:  job.roleType || 'PM',
            salary:    job.salary || null,
            postedAt:  job.postedAt ? new Date(job.postedAt) : null,
            status:    applyMode === 'AUTO' ? 'QUEUED' : 'FOUND',
            applyMode: applyMode as any,
          },
        })
        saved++
      } catch (e: any) {
        if (e.code === 'P2002') { skipped++; continue } // unique constraint
        throw e
      }
    }

    // Update scraper run log — tag the specific run if we have its id, else
    // touch all currently-RUNNING rows as a fallback.
    if (runId) {
      await prisma.scraperRun.updateMany({
        where: { id: runId },
        data: {
          jobsFound: { increment: saved },
          status: 'COMPLETED',
          completedAt: new Date(),
        },
      })
    } else {
      await prisma.scraperRun.updateMany({
        where: { status: 'RUNNING' },
        data: { jobsFound: { increment: saved } },
      })
    }

    // Trigger applicator for AUTO mode jobs
    if (applyMode === 'AUTO') {
      // Fire and forget - the queue processor picks up QUEUED jobs
      void processQueue()
    }

    return NextResponse.json({ saved, skipped, total: jobs.length })
  } catch (err) {
    console.error('Ingest error:', err)
    return NextResponse.json({ error: 'Ingest failed' }, { status: 500 })
  }
}

async function processQueue() {
  const scraperUrl = process.env.SCRAPER_API_URL
  if (!scraperUrl) {
    console.log('[apply-queue] SCRAPER_API_URL not set — skipping auto-apply')
    return
  }

  const queued = await prisma.job.findMany({
    where: { status: 'QUEUED', applyMode: 'AUTO' },
    take: 20,
    orderBy: { scrapedAt: 'asc' },
  })

  console.log(`[apply-queue] ${queued.length} jobs to apply`)

  let applied = 0
  let failedNoCv = 0
  let failedApi = 0

  for (const job of queued) {
    try {
      // Get the right CV for this role type
      const cv = await prisma.cV.findUnique({ where: { roleType: job.roleType as any } })
      if (!cv) {
        console.log(`[apply-queue] job ${job.id}: no CV uploaded for roleType=${job.roleType} — marking FAILED`)
        await prisma.job.update({
          where: { id: job.id },
          data: { status: 'FAILED', matchNotes: `Auto-apply failed: no CV uploaded for role ${job.roleType}` },
        }).catch(() => {})
        failedNoCv++
        continue
      }

      // Get credentials for this source
      const cred = await prisma.credential.findUnique({ where: { siteName: capitalise(job.source) } })
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

  console.log(`[apply-queue] done — applied=${applied}, failed-no-cv=${failedNoCv}, failed-api=${failedApi}`)
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}
