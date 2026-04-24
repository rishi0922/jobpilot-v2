import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

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

    // Update scraper run log
    await prisma.scraperRun.updateMany({
      where: { status: 'RUNNING' },
      data: {
        jobsFound:   { increment: jobs.length },
        jobsApplied: 0,
        status:      'RUNNING',
      },
    })

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
  if (!scraperUrl) return

  const queued = await prisma.job.findMany({
    where: { status: 'QUEUED', applyMode: 'AUTO' },
    take: 20,
    orderBy: { scrapedAt: 'asc' },
  })

  for (const job of queued) {
    try {
      // Get the right CV for this role type
      const cv = await prisma.cV.findUnique({ where: { roleType: job.roleType as any } })
      if (!cv) continue

      // Get credentials for this source
      const cred = await prisma.credential.findUnique({ where: { siteName: capitalise(job.source) } })

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

      const result = await res.json()
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status:    result.success ? 'APPLIED' : 'FAILED',
          appliedAt: result.success ? new Date() : undefined,
          cvUsed:    job.roleType,
        },
      })
    } catch (e) {
      await prisma.job.update({ where: { id: job.id }, data: { status: 'FAILED' } })
    }
  }
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}
