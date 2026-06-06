import { NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { getCurrentUserId } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROLE_LABELS: Record<string, string> = {
  APM: 'APM',
  PM: 'PM',
  PROJECT_MANAGER: 'Project Mgr',
  PROGRAM_MANAGER: 'Program Mgr',
  BUSINESS_ANALYST: 'BA',
}

export async function GET() {
  const userId = await getCurrentUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    // Every count/groupBy below is scoped to this user — stats only reflect
    // the signed-in user's job pool, not the global dataset.
    const [
      totalFound, totalApplied, inReview, interviews, failed,
      byRoleAll, byRoleApplied, byRoleInterview,
      bySource, byStatus, recentRuns,
    ] = await Promise.all([
      prisma.job.count({ where: { userId } }),
      prisma.job.count({ where: { userId, status: { in: ['APPLIED', 'IN_REVIEW', 'INTERVIEW'] } } }),
      prisma.job.count({ where: { userId, status: 'IN_REVIEW' } }),
      prisma.job.count({ where: { userId, status: 'INTERVIEW' } }),
      prisma.job.count({ where: { userId, status: 'FAILED' } }),
      prisma.job.groupBy({ by: ['roleType'], _count: { id: true }, where: { userId } }),
      prisma.job.groupBy({
        by: ['roleType'],
        _count: { id: true },
        where: { userId, status: { in: ['APPLIED', 'IN_REVIEW', 'INTERVIEW'] } },
      }),
      prisma.job.groupBy({
        by: ['roleType'],
        _count: { id: true },
        where: { userId, status: 'INTERVIEW' },
      }),
      prisma.job.groupBy({ by: ['source'], _count: { id: true }, where: { userId }, orderBy: { _count: { id: 'desc' } }, take: 10 }),
      prisma.job.groupBy({ by: ['status'], _count: { id: true }, where: { userId } }),
      prisma.scraperRun.findMany({ where: { userId }, orderBy: { startedAt: 'desc' }, take: 7 }),
    ])

    const appliedByRole = Object.fromEntries(byRoleApplied.map(r => [r.roleType, r._count.id]))
    const interviewByRole = Object.fromEntries(byRoleInterview.map(r => [r.roleType, r._count.id]))

    const recentActivity = recentRuns
      .slice()
      .reverse()
      .map(r => ({
        date: r.startedAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
        found: r.jobsFound,
        applied: r.jobsApplied,
      }))

    // Pull source-health stats from the most recent run that actually
    // recorded any. Older runs without sourceStats are skipped.
    const latestWithStats = recentRuns.find(r => r.sourceStats && Object.keys(r.sourceStats as any).length > 0)
    const sourceHealth = latestWithStats
      ? Object.entries((latestWithStats.sourceStats as any) || {}).map(([source, s]: [string, any]) => ({
          source,
          found:   Number(s?.found   ?? 0),
          kept:    Number(s?.kept    ?? 0),
          dropped: Number(s?.dropped ?? 0),
          skipped: Number(s?.skipped ?? 0),
          // success = scraper returned at least one usable job after quality gate
          ok: Number(s?.kept ?? 0) > 0,
        }))
      : []

    return NextResponse.json({
      totalFound, totalApplied, inReview, interviews, failed,
      successRate: totalApplied > 0 ? +((interviews / totalApplied) * 100).toFixed(1) : 0,
      byRole: byRoleAll.map(r => ({
        role: ROLE_LABELS[r.roleType] || r.roleType,
        roleType: r.roleType,
        found: r._count.id,
        count: r._count.id,
        applied: appliedByRole[r.roleType] || 0,
        interviews: interviewByRole[r.roleType] || 0,
      })),
      bySource: bySource.map(s => ({ source: s.source, count: s._count.id })),
      byStatus: byStatus.map(s => ({ status: s.status, count: s._count.id })),
      recentActivity,
      lastScraperRun: recentRuns[0]?.completedAt ?? null,
      scraperStatus: recentRuns[0]?.status ?? 'idle',
      sourceHealth,
      lastRunAt: latestWithStats?.startedAt ?? null,
    })
  } catch (err) {
    console.error('GET /api/stats error:', err)
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 })
  }
}
