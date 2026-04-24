import { NextRequest, NextResponse } from 'next/server'
import { analyzeCV, generatePostApplicationInsights } from '@/lib/cv-analysis'
import prisma from '@/lib/db'

export async function POST(req: NextRequest) {
  try {
    const { type, cvText, jobDescription, roleType, jobId } = await req.json()

    if (type === 'pre_application') {
      if (!cvText || !jobDescription) {
        return NextResponse.json({ error: 'cvText and jobDescription required' }, { status: 400 })
      }
      const result = await analyzeCV(cvText, jobDescription, roleType || 'PM')

      // Save analysis to DB if jobId provided
      if (jobId) {
        await prisma.cvAnalysis.create({
          data: {
            cvId: roleType || 'unknown',
            jobId,
            analysisType: 'pre_application',
            matchScore: result.matchScore,
            strengths: result.strengths,
            gaps: result.gaps,
            suggestions: result.suggestions,
            keywords: result.keywords,
          }
        })
        await prisma.job.update({
          where: { id: jobId },
          data: { matchScore: result.matchScore, matchNotes: result.summary },
        })
      }

      return NextResponse.json(result)
    }

    if (type === 'post_application') {
      const jobs = await prisma.job.findMany({
        where: { status: { in: ['APPLIED', 'IN_REVIEW', 'INTERVIEW', 'REJECTED', 'FAILED'] } },
        select: { roleType: true, company: true, source: true, status: true, cvUsed: true, matchScore: true, description: true },
        take: 100,
        orderBy: { appliedAt: 'desc' },
      })

      const insights = await generatePostApplicationInsights(
        jobs.map(j => ({
          roleType: j.roleType,
          company: j.company,
          source: j.source,
          status: j.status,
          cvUsed: j.cvUsed || '',
          matchScore: j.matchScore ?? undefined,
          jobDescription: j.description ?? undefined,
        }))
      )

      return NextResponse.json(insights)
    }

    return NextResponse.json({ error: 'Invalid type. Use pre_application or post_application' }, { status: 400 })
  } catch (err) {
    console.error('CV analysis error:', err)
    return NextResponse.json({ error: 'Analysis failed' }, { status: 500 })
  }
}
