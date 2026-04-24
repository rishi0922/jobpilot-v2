import { NextResponse } from 'next/server'
import prisma from '@/lib/db'

export async function GET() {
  try {
    const [
      totalFound, totalApplied, inReview, interviews, failed,
      byRole, bySource, byStatus, recentRuns
    ] = await Promise.all([
      prisma.job.count(),
      prisma.job.count({ where: { status: { in: ['APPLIED', 'IN_REVIEW', 'INTERVIEW'] } } }),
      prisma.job.count({ where: { status: 'IN_REVIEW' } }),
      prisma.job.count({ where: { status: 'INTERVIEW' } }),
      prisma.job.count({ where: { status: 'FAILED' } }),
      prisma.job.groupBy({ by: ['roleType'], _count: { id: true } }),
      prisma.job.groupBy({ by: ['source'], _count: { id: true }, orderBy: { _count: { id: 'desc' } }, take: 10 }),
      prisma.job.groupBy({ by: ['status'], _count: { id: true } }),
      prisma.scraperRun.findMany({ orderBy: { startedAt: 'desc' }, take: 7 }),
    ])

    const recentActivity = recentRuns.map(r => ({
      date: r.startedAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
      found: r.jobsFound,
      applied: r.jobsApplied,
    }))

    return NextResponse.json({
      totalFound, totalApplied, inReview, interviews, failed,
      successRate: totalApplied > 0 ? +((interviews / totalApplied) * 100).toFixed(1) : 0,
      byRole: byRole.map(r => ({ role: r.roleType, count: r._count.id })),
      bySource: bySource.map(s => ({ source: s.source, count: s._count.id })),
      byStatus: byStatus.map(s => ({ status: s.status, count: s._count.id })),
      recentActivity,
      lastScraperRun: recentRuns[0]?.completedAt ?? null,
      scraperStatus: recentRuns[0]?.status ?? 'idle',
    })
  } catch (err) {
    console.error('GET /api/stats error:', err)
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 })
  }
}
