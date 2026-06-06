import { NextRequest, NextResponse } from 'next/server'
import { hash } from 'bcryptjs'
import prisma from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Email + password sign-up. Three gates:
 *   1. Email must be in EmailAllowlist (the public landing page surfaces
 *      a "join the waitlist" flow for everyone else).
 *   2. Email must not already have an account (returns 409 Conflict).
 *   3. Password must be at least 8 characters.
 *
 * On success: creates a User row with bcrypt-hashed password. Profile row
 * is auto-created by the NextAuth `events.createUser` callback on first
 * sign-in. We DO NOT auto-sign-in here — the client redirects to /signin
 * with the email pre-filled so the user goes through the normal NextAuth
 * Credentials flow.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const email    = (body.email    || '').toLowerCase().trim()
    const password = body.password as string
    const name     = (body.name     || '').trim() || null

    // Validation
    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Valid email is required' }, { status: 400 })
    }
    if (!password || password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      )
    }

    // Allowlist gate
    const allowed = await prisma.emailAllowlist.findUnique({ where: { email } })
    if (!allowed) {
      // 403 with a specific message the signup page can recognise and redirect
      return NextResponse.json(
        {
          error:    'not_allowed',
          message:  'This email is not on the allowlist. Join the waitlist instead.',
          waitlist: '/waitlist',
        },
        { status: 403 }
      )
    }

    // Duplicate check
    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) {
      return NextResponse.json(
        { error: 'An account with this email already exists' },
        { status: 409 }
      )
    }

    // Create
    const passwordHash = await hash(password, 12)
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
        // First user becomes admin so they can manage the allowlist.
        // After that everyone is USER until manually promoted.
        role: (await prisma.user.count()) === 0 ? 'ADMIN' : 'USER',
      },
      select: { id: true, email: true, role: true },
    })

    // Profile is created by NextAuth events.createUser on first sign-in.
    // We don't create it here because the user might never sign in.

    return NextResponse.json({ ok: true, user })
  } catch (err: any) {
    console.error('Signup error:', err)
    return NextResponse.json({ error: err?.message || 'Signup failed' }, { status: 500 })
  }
}
