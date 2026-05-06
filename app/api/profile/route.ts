import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PROFILE_ID = 'default'

// Hand-curated defaults so the scoring engine has SOMETHING to work with on
// a fresh install. Users override these in /settings → Profile.
const DEFAULT_PROFILE = {
  id:                  PROFILE_ID,
  fullName:            null,
  email:               null,
  phone:               null,
  yearsExperience:     null,
  currentRole:         null,
  expectedSalaryLpa:   null,
  noticePeriodDays:    null,
  skills:              [] as string[],
  preferredLocations:  ['bengaluru', 'remote'] as string[],
  preferredIndustries: [] as string[],
  remoteOnly:          false,
  minMatchScore:       60,
}

export async function GET() {
  try {
    let profile = await prisma.profile.findUnique({ where: { id: PROFILE_ID } })
    if (!profile) {
      // Lazy-create the singleton so the UI always has a row to bind to.
      profile = await prisma.profile.create({ data: DEFAULT_PROFILE })
    }
    return NextResponse.json(profile)
  } catch (err) {
    console.error('GET /api/profile error:', err)
    return NextResponse.json({ error: 'Failed to load profile' }, { status: 500 })
  }
}

// PUT replaces the profile fields (still upsert-style). Fields omitted from
// the body are left untouched — the client can do partial updates.
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()

    // Whitelist allowed fields so a malicious caller can't smuggle in `id` etc.
    const allowed = [
      'fullName', 'email', 'phone',
      'yearsExperience', 'currentRole', 'expectedSalaryLpa', 'noticePeriodDays',
      'skills', 'preferredLocations', 'preferredIndustries',
      'remoteOnly', 'minMatchScore',
    ] as const

    const data: any = {}
    for (const k of allowed) {
      if (body[k] === undefined) continue
      if (k === 'skills' || k === 'preferredLocations' || k === 'preferredIndustries') {
        // Normalise: lowercase + trim + dedupe
        const arr = Array.isArray(body[k]) ? body[k] : []
        data[k] = Array.from(new Set(
          arr.map((s: any) => String(s).trim().toLowerCase()).filter(Boolean)
        ))
      } else if (k === 'minMatchScore' || k === 'yearsExperience' || k === 'expectedSalaryLpa' || k === 'noticePeriodDays') {
        if (body[k] === null || body[k] === '') data[k] = null
        else data[k] = Math.max(0, Math.min(100, Number(body[k]) || 0))
      } else if (k === 'remoteOnly') {
        data[k] = !!body[k]
      } else {
        data[k] = body[k] === '' ? null : String(body[k])
      }
    }

    const profile = await prisma.profile.upsert({
      where:  { id: PROFILE_ID },
      update: data,
      create: { ...DEFAULT_PROFILE, ...data, id: PROFILE_ID },
    })
    return NextResponse.json(profile)
  } catch (err: any) {
    console.error('PUT /api/profile error:', err)
    return NextResponse.json({ error: err?.message || 'Failed to save profile' }, { status: 500 })
  }
}
