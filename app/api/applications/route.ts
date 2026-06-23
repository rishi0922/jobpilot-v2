import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { getCurrentUserId } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VALID_OUTCOMES = ['APPLIED', 'IN_REVIEW', 'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN']

/**
 * GET  — list the current user's applied-role history (newest first).
 *        Optional ?outcome=INTERVIEW filter.
 * PATCH — update an application's outcome + notes:
 *        { id, outcome?, outcomeNotes? }
 *
 * This reads the durable AppliedRole table, which persists independently
 * of the live Job rows.
 */
export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const url = new URL(req.url)
    const outcome = url.searchParams.get('outcome')
    const where: any = { userId }
    if (outcome && VALID_OUTCOMES.includes(outcome)) where.outcome = outcome

    const [rows, total] = await Promise.all([
      prisma.appliedRole.findMany({ where, orderBy: { appliedAt: 'desc' } }),
      prisma.appliedRole.count({ where: { userId } }),
    ])
    return NextResponse.json({ rows, total })
  } catch (err: any) {
    console.error('GET /api/applications error:', err)
    return NextResponse.json({ error: 'Failed to load applications' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const userId = await getCurrentUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const { id, outcome, outcomeNotes } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    if (outcome !== undefined && !VALID_OUTCOMES.includes(outcome)) {
      return NextResponse.json({ error: `outcome must be one of ${VALID_OUTCOMES.join(', ')}` }, { status: 400 })
    }

    // Ownership guard
    const owns = await prisma.appliedRole.findFirst({ where: { id, userId }, select: { id: true } })
    if (!owns) return NextResponse.json({ error: 'Application not found' }, { status: 404 })

    const data: any = {}
    if (outcome !== undefined) data.outcome = outcome
    if (outcomeNotes !== undefined) data.outcomeNotes = outcomeNotes === '' ? null : String(outcomeNotes)

    const updated = await prisma.appliedRole.update({ where: { id }, data })
    return NextResponse.json(updated)
  } catch (err: any) {
    console.error('PATCH /api/applications error:', err)
    return NextResponse.json({ error: err?.message || 'Failed to update application' }, { status: 500 })
  }
}
