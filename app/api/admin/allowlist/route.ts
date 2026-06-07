import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Admin-only allowlist management.
 *
 *   GET    → list current allowlist entries (most recently added first)
 *   POST   { email, note? } — add an entry (idempotent)
 *   DELETE ?email=foo@bar  — remove an entry
 */

async function requireAdmin() {
  const user = await getCurrentUser()
  if (!user) return { error: 'Unauthorized', status: 401 as const, user: null }
  if (user.role !== 'ADMIN') return { error: 'Admin only', status: 403 as const, user: null }
  return { error: null, status: 200 as const, user }
}

export async function GET() {
  const auth = await requireAdmin()
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rows = await prisma.emailAllowlist.findMany({ orderBy: { createdAt: 'desc' } })
  return NextResponse.json({ rows })
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin()
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { email, note } = await req.json()
    const normalised = (email || '').toLowerCase().trim()
    if (!normalised || !normalised.includes('@')) {
      return NextResponse.json({ error: 'Valid email required' }, { status: 400 })
    }
    const row = await prisma.emailAllowlist.upsert({
      where:  { email: normalised },
      update: { note: note ?? undefined },
      create: { email: normalised, note: note ?? null, invitedBy: auth.user!.id },
    })
    return NextResponse.json({ row })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin()
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const url = new URL(req.url)
    const email = (url.searchParams.get('email') || '').toLowerCase().trim()
    if (!email) return NextResponse.json({ error: 'email required' }, { status: 400 })
    await prisma.emailAllowlist.deleteMany({ where: { email } })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed' }, { status: 500 })
  }
}
