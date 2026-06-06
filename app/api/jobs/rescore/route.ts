import { NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { scoreJob, type ScoringProfile } from '@/lib/scoring'
import { getCurrentUserId } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Re-score every existing job *for the current user* against the latest
 * profile. Called from the Profile settings UI after the user edits their
 * preferences — without this, old jobs keep their stale scores and the
 * dashboard misleads the user.
 *
 * Scoped per-user: we only touch this user's jobs, against this user's
 * profile. A second user re-scoring their profile never affects the first
 * user's job rankings.
 */
export async function POST() {
  const userId = await getCurrentUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const p = await prisma.profile.findUnique({ where: { userId } })
    const profile: ScoringProfile | null = p ? {
      yearsExperience:     p.yearsExperience,
      skills:              p.skills || [],
      preferredLocations:  p.preferredLocations || [],
      preferredIndustries: p.preferredIndustries || [],
      remoteOnly:          !!p.remoteOnly,
    } : null

    // Process in pages to keep memory bounded on the serverless function.
    const PAGE_SIZE = 200
    let cursor: string | undefined
    let total = 0

    while (true) {
      const batch = await prisma.job.findMany({
        where: { userId },
        select: {
          id: true, title: true, company: true, location: true,
          description: true, roleType: true, source: true,
        },
        take: PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
      })
      if (batch.length === 0) break

      // Sequentially update; this endpoint is called on-demand and runs at
      // most a few times per session, so simplicity beats parallelism.
      for (const j of batch) {
        const { score, reasons, notes } = scoreJob(
          {
            title:       j.title,
            company:     j.company,
            location:    j.location,
            description: j.description,
            roleType:    j.roleType,
            source:      j.source,
          },
          profile
        )
        await prisma.job.update({
          where: { id: j.id },
          data:  { matchScore: score, matchNotes: notes, matchReasons: reasons as any },
        })
        total++
      }

      cursor = batch[batch.length - 1].id
      if (batch.length < PAGE_SIZE) break
    }

    return NextResponse.json({ rescored: total })
  } catch (err: any) {
    console.error('POST /api/jobs/rescore error:', err)
    return NextResponse.json({ error: err?.message || 'Rescore failed' }, { status: 500 })
  }
}
