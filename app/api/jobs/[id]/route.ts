import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/jobs/[id] — full job record incl. description and matchReasons
export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  try {
    const job = await prisma.job.findUnique({
      where:  { id: ctx.params.id },
      include: {
        applications: {
          orderBy: { submittedAt: 'desc' },
          take: 5,
          select: { id: true, status: true, submittedAt: true, errorLog: true, responseNote: true },
        },
      },
    })
    if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(job)
  } catch (err: any) {
    console.error('GET /api/jobs/[id] error:', err)
    return NextResponse.json({ error: err?.message || 'Failed to load job' }, { status: 500 })
  }
}
