import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File | null
    const roleType = formData.get('roleType') as string

    if (!file || !roleType) {
      return NextResponse.json(
        { error: 'File and roleType are required' },
        { status: 400 }
      )
    }

    if (file.type !== 'application/pdf') {
      return NextResponse.json(
        { error: 'Only PDF files are allowed' },
        { status: 400 }
      )
    }

    const bytes = await file.arrayBuffer()
    const buffer = Buffer.from(bytes)

    // Check if we have Vercel Blob configured (for future use, if installed)
    let fileUrl = ''
    
    // Fallback: Store as Base64 Data URI in the database
    const base64String = buffer.toString('base64')
    fileUrl = `data:application/pdf;base64,${base64String}`
    
    // Upsert the CV in the database
    const cv = await prisma.cV.upsert({
      where: { roleType: roleType as any },
      update: {
        fileName: file.name,
        fileUrl: fileUrl,
        version: { increment: 1 },
      },
      create: {
        roleType: roleType as any,
        fileName: file.name,
        fileUrl: fileUrl,
      },
    })

    return NextResponse.json({ success: true, cv })
  } catch (error) {
    console.error('Error uploading CV:', error)
    return NextResponse.json(
      { error: 'Failed to upload CV' },
      { status: 500 }
    )
  }
}

export async function GET(req: NextRequest) {
  try {
    const cvs = await prisma.cV.findMany({
      select: {
        id: true,
        roleType: true,
        fileName: true,
        version: true,
        uploadedAt: true,
      }
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
