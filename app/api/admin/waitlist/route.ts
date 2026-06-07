import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Admin-only: list waitlist requests, promote them to the allowlist, or
 * decline them. ADMIN role enforced on every method.
 *
 *   GET    → list rows, filterable by ?status=PENDING|APPROVED|DECLINED
 *   POST   { email, action: 'approve' | 'decline' }
 *            approve: upsert into EmailAllowlist + mark request APPROVED
 *            decline: mark request DECLINED (no allowlist change)
 */

async function requireAdmin() {
  const user = await getCurrentUser()
  if (!user) return { error: 'Unauthorized', status: 401 as const, user: null }
  if (user.role !== 'ADMIN') return { error: 'Admin only', status: 403 as const, user: null }
  return { error: null, status: 200 as const, user }
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin()
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const url = new URL(req.url)
  const status = url.searchParams.get('status') as 'PENDING' | 'APPROVED' | 'DECLINED' | null

  const rows = await prisma.waitlistRequest.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json({ rows })
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin()
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { email, action } = await req.json()
    const normalised = (email || '').toLowerCase().trim()
    if (!normalised) return NextResponse.json({ error: 'email required' }, { status: 400 })
    if (action !== 'approve' && action !== 'decline') {
      return NextResponse.json({ error: 'action must be approve or decline' }, { status: 400 })
    }

    if (action === 'approve') {
      // Add to allowlist (idempotent) and mark the request as APPROVED.
      // Done in a transaction so they always agree.
      await prisma.$transaction([
        prisma.emailAllowlist.upsert({
          where:  { email: normalised },
          update: { invitedBy: auth.user!.id },
          create: { email: normalised, invitedBy: auth.user!.id, note: 'Approved from waitlist' },
        }),
        prisma.waitlistRequest.updateMany({
          where: { email: normalised },
          data:  { status: 'APPROVED', reviewedAt: new Date() },
        }),
      ])
    } else {
      await prisma.waitlistRequest.updateMany({
        where: { email: normalised },
        data:  { status: 'DECLINED', reviewedAt: new Date() },
      })
    }

    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('admin/waitlist error:', err)
    return NextResponse.json({ error: err?.message || 'Failed' }, { status: 500 })
  }
}
