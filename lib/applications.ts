import prisma from './db'

/**
 * Record (or refresh) a durable AppliedRole history row for a job the user
 * applied to. Called from:
 *   - the manual "Mark applied" path (PATCH /api/jobs, status=APPLIED)
 *   - the auto-applicator success path (processQueue in scraper/ingest)
 *
 * Snapshots the job's title/company/JD/match-score at apply-time so the
 * history survives even after the live Job row is deleted. Idempotent via
 * the @@unique([userId, sourceUrl]) constraint — re-applying updates the
 * snapshot rather than creating duplicates, but never downgrades an outcome
 * the user has already advanced (e.g. won't reset INTERVIEW back to APPLIED).
 */
export async function recordAppliedRole(params: {
  userId: string
  jobId?: string | null
  title: string
  company: string
  location?: string | null
  source: string
  sourceUrl: string
  roleType: string
  jobDescription?: string | null
  matchScoreAtApply?: number | null
  cvUsed?: string | null
}): Promise<void> {
  const {
    userId, jobId, title, company, location, source, sourceUrl,
    roleType, jobDescription, matchScoreAtApply, cvUsed,
  } = params

  try {
    await prisma.appliedRole.upsert({
      where: { userId_sourceUrl: { userId, sourceUrl } },
      // On re-apply we refresh the snapshot fields but DON'T touch `outcome`
      // or `outcomeNotes` — those are user-owned and may have advanced past
      // APPLIED. Leaving them out of `update` preserves whatever stage the
      // user set.
      update: {
        jobId:             jobId ?? undefined,
        title,
        company,
        location:          location ?? undefined,
        source,
        roleType:          roleType as any,
        jobDescription:    jobDescription ?? undefined,
        matchScoreAtApply: matchScoreAtApply ?? undefined,
        cvUsed:            cvUsed ?? undefined,
      },
      create: {
        userId,
        jobId:             jobId ?? null,
        title,
        company,
        location:          location ?? null,
        source,
        sourceUrl,
        roleType:          roleType as any,
        jobDescription:    jobDescription ?? null,
        matchScoreAtApply: matchScoreAtApply ?? null,
        cvUsed:            cvUsed ?? null,
        outcome:           'APPLIED',
      },
    })
  } catch (e) {
    // History recording must never break the apply flow itself. Log + move on.
    console.error('[recordAppliedRole] failed:', e)
  }
}
