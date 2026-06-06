import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { getCurrentUserId } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const VALID_ROLES = ['APM', 'PM', 'PROJECT_MANAGER', 'PROGRAM_MANAGER', 'BUSINESS_ANALYST']
// Vercel serverless body limit is 4.5MB. Base64 encoding inflates by ~33%,
// so the practical raw-PDF limit is ~3.3MB. Reject early with a clear error.
const MAX_PDF_BYTES = 3 * 1024 * 1024

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File | null
    const roleType = (formData.get('roleType') as string | null)?.trim()

    if (!file || !roleType) {
      return NextResponse.json(
        { error: 'File and roleType are required' },
        { status: 400 }
      )
    }

    if (!VALID_ROLES.includes(roleType)) {
      return NextResponse.json(
        { error: `Invalid roleType. Must be one of: ${VALID_ROLES.join(', ')}` },
        { status: 400 }
      )
    }

    if (file.type !== 'application/pdf') {
      return NextResponse.json(
        { error: 'Only PDF files are allowed' },
        { status: 400 }
      )
    }

    if (file.size > MAX_PDF_BYTES) {
      return NextResponse.json(
        {
          error: `PDF too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max ${(MAX_PDF_BYTES / 1024 / 1024).toFixed(1)}MB on the current deployment plan. Compress the PDF and retry.`,
        },
        { status: 413 }
      )
    }

    const bytes = await file.arrayBuffer()
    const buffer = Buffer.from(bytes)
    const base64String = buffer.toString('base64')
    const fileUrl = `data:application/pdf;base64,${base64String}`

    const cv = await prisma.cV.upsert({
      where: { userId_roleType: { userId, roleType: roleType as any } },
      update: {
        fileName: file.name,
        fileUrl,
        version: { increment: 1 },
      },
      create: {
        userId,
        roleType: roleType as any,
        fileName: file.name,
        fileUrl,
      },
      select: {
        id: true,
        roleType: true,
        fileName: true,
        version: true,
        uploadedAt: true,
      },
    })

    return NextResponse.json({ success: true, cv })
  } catch (error: any) {
    console.error('Error uploading CV:', error)
    return NextResponse.json(
      { error: error?.message || 'Failed to upload CV' },
      { status: 500 }
    )
  }
}

export async function GET() {
  const userId = await getCurrentUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const cvs = await prisma.cV.findMany({
      where: { userId },
      select: {
        id: true,
        roleType: true,
        fileName: true,
        version: true,
        uploadedAt: true,
      },
    })
    return NextResponse.json({ cvs })
  } catch (error) {
    console.error('Error fetching CVs:', error)
    return NextResponse.json(
      { error: 'Failed to fetch CVs' },
      { status: 500 }
    )
  }
}
