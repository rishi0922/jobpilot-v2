import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { getCurrentUserId } from '@/lib/auth'
import { recordAppliedRole } from '@/lib/applications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const { searchParams } = new URL(req.url)
    const roleType = searchParams.get('roleType')
    const status   = searchParams.get('status')
    const source   = searchParams.get('source')
    const page     = parseInt(searchParams.get('page') || '1')
    const limit    = parseInt(searchParams.get('limit') || '50')
    // Date filter — `scrapedAfter` is an ISO timestamp; jobs with scrapedAt
    // strictly later than this are returned. Lets the UI offer "today / last
    // 7 days / last 30 days" filters without server-side date math.
    const scrapedAfter  = searchParams.get('scrapedAfter')
    const scrapedBefore = searchParams.get('scrapedBefore')

    const where: any = { userId }
    if (roleType) where.roleType = roleType
    if (status)   where.status   = status
    if (source)   where.source   = source
    if (scrapedAfter || scrapedBefore) {
      where.scrapedAt = {}
      if (scrapedAfter) {
        const d = new Date(scrapedAfter)
        if (!isNaN(d.getTime())) where.scrapedAt.gte = d
      }
      if (scrapedBefore) {
        const d = new Date(scrapedBefore)
        if (!isNaN(d.getTime())) where.scrapedAt.lte = d
      }
      // If neither parsed cleanly, drop the empty filter entirely so Prisma
      // doesn't choke on `{ scrapedAt: {} }`.
      if (Object.keys(where.scrapedAt).length === 0) delete where.scrapedAt
    }

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        orderBy: { scrapedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.job.count({ where }),
    ])

    return NextResponse.json({ jobs, total, page, pages: Math.ceil(total / limit) })
  } catch (err) {
    console.error('GET /api/jobs error:', err)
    return NextResponse.json({ error: 'Failed to fetch jobs' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const userId = await getCurrentUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const { id, status, applyMode, cvUsed } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    // Verify ownership before mutating — a logged-in user shouldn't be able
    // to modify another user's job by guessing the cuid. Pull the full row so
    // we can snapshot it into AppliedRole history if this is a mark-applied.
    const owns = await prisma.job.findFirst({
      where: { id, userId },
    })
    if (!owns) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

    const data: any = { lastUpdated: new Date() }
    if (status !== undefined) data.status = status
    if (applyMode !== undefined) data.applyMode = applyMode
    if (cvUsed !== undefined) data.cvUsed = cvUsed
    if (status === 'APPLIED') data.appliedAt = new Date()
    const updated = await prisma.job.update({ where: { id }, data })

    // On transition to APPLIED, write a durable history row that snapshots
    // the job so it survives the eventual cleanup of the live Job row.
    if (status === 'APPLIED') {
      await recordAppliedRole({
        userId,
        jobId:             owns.id,
        title:             owns.title,
        company:           owns.company,
        location:          owns.location,
        source:            owns.source,
        sourceUrl:         owns.sourceUrl,
        roleType:          owns.roleType,
        jobDescription:    owns.description,
        matchScoreAtApply: owns.matchScore,
        cvUsed:            cvUsed ?? owns.cvUsed ?? owns.roleType,
      })
    }

    return NextResponse.json(updated)
  } catch (err: any) {
    console.error('PATCH /api/jobs error:', err)
    return NextResponse.json({ error: err?.message || 'Failed to update job' }, { status: 500 })
  }
}
