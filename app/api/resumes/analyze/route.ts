import { NextRequest, NextResponse } from 'next/server'
import { analyzeCV, analyzeCVFromPdfBase64, generatePostApplicationInsights } from '@/lib/cv-analysis'
import prisma from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Claude PDF analysis can take ~10-30s. Bump from the default 10s.
export const maxDuration = 60

/**
 * Two analysis flavours behind one endpoint:
 *
 *  1. type=pre_application — CV-vs-JD match score + strengths/gaps/keywords.
 *     Accepts either:
 *        { cvText, jobDescription, roleType, jobId? }   — plain-text CV
 *        { cvId,   jobDescription, roleType, jobId? }   — saved CV from DB
 *     The cvId path pulls the stored base64 PDF off the CV row and lets
 *     Claude read it directly (no Node-side PDF parser needed). cvText is
 *     kept for the case where the user pastes raw CV text.
 *
 *  2. type=post_application — pattern analysis across all applied jobs.
 *     No CV input needed; reads Job/Application rows from the DB.
 */
export async function POST(req: NextRequest) {
  // Fail fast with a clear message if the Gemini key is missing on this
  // deployment — otherwise the SDK throws an unhelpful error from inside
  // the client constructor, which is opaque to a user looking at the UI.
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      {
        error:
          'GEMINI_API_KEY is not set on this deployment. Get a free key ' +
          'at https://aistudio.google.com/apikey, add it in Vercel → ' +
          'Settings → Environment Variables, then redeploy.',
      },
      { status: 503 }
    )
  }

  try {
    const body = await req.json()
    const { type, cvText, cvId, jobDescription, roleType, jobId } = body

    if (type === 'pre_application') {
      if (!jobDescription) {
        return NextResponse.json({ error: 'jobDescription is required' }, { status: 400 })
      }
      if (!cvText && !cvId) {
        return NextResponse.json({ error: 'Provide either cvText or cvId' }, { status: 400 })
      }

      let result
      let cvIdForSave: string = roleType || 'unknown'

      if (cvId) {
        // Look up the stored CV. fileUrl is a data:application/pdf;base64,... URL.
        const cv = await prisma.cV.findUnique({
          where: { id: cvId },
          select: { id: true, roleType: true, fileUrl: true, fileName: true },
        })
        if (!cv) {
          return NextResponse.json({ error: `CV not found: ${cvId}` }, { status: 404 })
        }
        // Strip the data-URL prefix to get pure base64 bytes.
        const base64 = (cv.fileUrl || '').replace(/^data:[^;]+;base64,/, '')
        if (!base64) {
          return NextResponse.json({ error: 'CV file is empty or corrupted' }, { status: 400 })
        }
        result = await analyzeCVFromPdfBase64(
          base64,
          jobDescription,
          roleType || cv.roleType,
        )
        cvIdForSave = cv.id
      } else {
        result = await analyzeCV(cvText, jobDescription, roleType || 'PM')
      }

      // Persist the analysis if this was tied to a specific job listing.
      if (jobId) {
        await prisma.cvAnalysis.create({
          data: {
            cvId:          cvIdForSave,
            jobId,
            analysisType:  'pre_application',
            matchScore:    result.matchScore,
            strengths:     result.strengths,
            gaps:          result.gaps,
            suggestions:   result.suggestions,
            keywords:      result.keywords,
          },
        })
        await prisma.job.update({
          where: { id: jobId },
          data:  { matchScore: result.matchScore, matchNotes: result.summary },
        })
      }

      return NextResponse.json(result)
    }

    if (type === 'post_application') {
      const jobs = await prisma.job.findMany({
        where:  { status: { in: ['APPLIED', 'IN_REVIEW', 'INTERVIEW', 'REJECTED', 'FAILED'] } },
        select: { roleType: true, company: true, source: true, status: true, cvUsed: true, matchScore: true, description: true },
        take:   100,
        orderBy: { appliedAt: 'desc' },
      })

      const insights = await generatePostApplicationInsights(
        jobs.map(j => ({
          roleType:       j.roleType,
          company:        j.company,
          source:         j.source,
          status:         j.status,
          cvUsed:         j.cvUsed || '',
          matchScore:     j.matchScore ?? undefined,
          jobDescription: j.description ?? undefined,
        }))
      )

      return NextResponse.json({ ...insights, applied: jobs.length })
    }

    return NextResponse.json({ error: 'Invalid type. Use pre_application or post_application' }, { status: 400 })
  } catch (err: any) {
    console.error('CV analysis error:', err)
    return NextResponse.json({ error: err?.message || 'Analysis failed' }, { status: 500 })
  }
}
