import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { encrypt, decrypt } from '@/lib/crypto'
import { getCurrentUserId, resolveScraperUserId } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET — list the current user's credentials (no passwords).
 * POST — save / update a credential for the current user.
 * PUT  — scraper-only (x-api-key); fetches the decrypted password for a
 *        given user's saved credential. Used by main.py during scrape.
 *
 * Multi-user notes:
 *  - GET/POST require a NextAuth session. 401 if absent.
 *  - PUT keeps x-api-key auth but now needs a userId in the body (or falls
 *    back to first admin via resolveScraperUserId — see lib/auth.ts).
 *  - The unique constraint on Credential is now compound (userId + siteName)
 *    so the upsert key is `userId_siteName`.
 */

export async function GET() {
  const userId = await getCurrentUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const creds = await prisma.credential.findMany({
      where:  { userId },
      select: { id: true, siteName: true, siteUrl: true, username: true, isActive: true, lastUsed: true },
    })
    return NextResponse.json(creds)
  } catch (err) {
    return NextResponse.json({ error: 'Failed to fetch credentials' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const { siteName, siteUrl, username, password } = await req.json()
    if (!siteName || !username || !password) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
    const passwordEnc = encrypt(password)
    const cred = await prisma.credential.upsert({
      where:  { userId_siteName: { userId, siteName } },
      update: { username, passwordEnc, siteUrl, isActive: true },
      create: { userId, siteName, siteUrl: siteUrl || '', username, passwordEnc },
    })
    return NextResponse.json({ id: cred.id, siteName: cred.siteName, username: cred.username, saved: true })
  } catch (err) {
    console.error('POST /api/credentials error:', err)
    return NextResponse.json({ error: 'Failed to save credential' }, { status: 500 })
  }
}

// Internal use only — called by the scraper service with valid API key.
// Now takes an optional userId in the body; falls back to the first admin
// user if missing (transitional until main.py is updated in Commit 4).
export async function PUT(req: NextRequest) {
  const apiKey = req.headers.get('x-api-key')
  if (apiKey !== process.env.SCRAPER_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const body = await req.json()
    const { siteName } = body
    const userId = await resolveScraperUserId(body)
    if (!userId) {
      return NextResponse.json({ error: 'No users in system' }, { status: 503 })
    }
    const cred = await prisma.credential.findUnique({
      where: { userId_siteName: { userId, siteName } },
    })
    if (!cred) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const password = decrypt(cred.passwordEnc)
    await prisma.credential.update({
      where: { userId_siteName: { userId, siteName } },
      data:  { lastUsed: new Date() },
    })
    return NextResponse.json({ username: cred.username, password })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to retrieve credential' }, { status: 500 })
  }
}
