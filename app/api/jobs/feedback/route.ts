import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST { id, feedback: 'UP' | 'DOWN' | null }
export async function POST(req: NextRequest) {
  try {
    const { id, feedback } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    if (feedback !== null && feedback !== 'UP' && feedback !== 'DOWN') {
      return NextResponse.json({ error: 'feedback must be UP, DOWN, or null' }, { status: 400 })
    }
    const updated = await prisma.job.update({
      where: { id },
      data:  { feedback },
      select: { id: true, feedback: true },
    })
    return NextResponse.json(updated)
  } catch (err: any) {
    console.error('POST /api/jobs/feedback error:', err)
    return NextResponse.json({ error: err?.message || 'Failed to save feedback' }, { status: 500 })
  }
}
