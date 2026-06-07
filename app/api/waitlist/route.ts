import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/waitlist — records a request for access from someone whose
 * email isn't on the allowlist. No auth required (the whole point is that
 * the user is not signed in).
 *
 * Idempotent: re-submitting the same email returns 200 without creating
 * a duplicate row (just updates the optional fields if provided).
 *
 * Admins can later promote PENDING entries to EmailAllowlist via an
 * admin page (built in commit 4).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const email  = (body.email  || '').toLowerCase().trim()
    const name   = (body.name   || '').trim() || null
    const reason = (body.reason || '').trim() || null

    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Valid email is required' }, { status: 400 })
    }

    await prisma.waitlistRequest.upsert({
      where:  { email },
      update: {
        name:   name || undefined,    // don't overwrite existing values with empty
        reason: reason || undefined,
      },
      create: { email, name, reason },
    })

    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('waitlist error:', err)
    return NextResponse.json({ error: err?.message || 'Waitlist signup failed' }, { status: 500 })
  }
}
