import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { getCurrentUserId } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/jobs/[id] — full job record incl. description and matchReasons.
// findFirst with userId guard so a logged-in user can't read another
// user's jobs via guessed cuid.
export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const userId = await getCurrentUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const job = await prisma.job.findFirst({
      where:  { id: ctx.params.id, userId },
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
