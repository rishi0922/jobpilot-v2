import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { encrypt, decrypt } from '@/lib/crypto'

export async function GET() {
  try {
    const creds = await prisma.credential.findMany({
      select: { id: true, siteName: true, siteUrl: true, username: true, isActive: true, lastUsed: true },
    })
    return NextResponse.json(creds)
  } catch (err) {
    return NextResponse.json({ error: 'Failed to fetch credentials' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { siteName, siteUrl, username, password } = await req.json()
    if (!siteName || !username || !password) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
    const passwordEnc = encrypt(password)
    const cred = await prisma.credential.upsert({
      where: { siteName },
      update: { username, passwordEnc, siteUrl, isActive: true },
      create: { siteName, siteUrl: siteUrl || '', username, passwordEnc },
    })
    return NextResponse.json({ id: cred.id, siteName: cred.siteName, username: cred.username, saved: true })
  } catch (err) {
    console.error('POST /api/credentials error:', err)
    return NextResponse.json({ error: 'Failed to save credential' }, { status: 500 })
  }
}

// Internal use only - called by scraper service with valid API key
export async function PUT(req: NextRequest) {
  const apiKey = req.headers.get('x-api-key')
  if (apiKey !== process.env.SCRAPER_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const { siteName } = await req.json()
    const cred = await prisma.credential.findUnique({ where: { siteName } })
    if (!cred) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const password = decrypt(cred.passwordEnc)
    await prisma.credential.update({ where: { siteName }, data: { lastUsed: new Date() } })
    return NextResponse.json({ username: cred.username, password })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to retrieve credential' }, { status: 500 })
  }
}
