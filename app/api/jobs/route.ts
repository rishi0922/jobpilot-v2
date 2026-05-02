import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const roleType = searchParams.get('roleType')
    const status = searchParams.get('status')
    const source = searchParams.get('source')
    const page = parseInt(searchParams.get('page') || '1')
    const limit = parseInt(searchParams.get('limit') || '50')

    const where: any = {}
    if (roleType) where.roleType = roleType
    if (status) where.status = status
    if (source) where.source = source

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
  try {
    const { id, status, applyMode, cvUsed } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    const data: any = { lastUpdated: new Date() }
    if (status !== undefined) data.status = status
    if (applyMode !== undefined) data.applyMode = applyMode
    if (cvUsed !== undefined) data.cvUsed = cvUsed
    if (status === 'APPLIED') data.appliedAt = new Date()
    const updated = await prisma.job.update({ where: { id }, data })
    return NextResponse.json(updated)
  } catch (err: any) {
    console.error('PATCH /api/jobs error:', err)
    return NextResponse.json({ error: err?.message || 'Failed to update job' }, { status: 500 })
  }
}
