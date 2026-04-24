import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

export async function POST(req: NextRequest) {
  const scraperUrl = process.env.SCRAPER_API_URL
  if (!scraperUrl) {
    return NextResponse.json({ error: 'SCRAPER_API_URL not configured' }, { status: 500 })
  }

  try {
    // Create a run record
    const run = await prisma.scraperRun.create({
      data: { status: 'RUNNING', sources: ['naukri', 'linkedin', 'iimjobs', 'instahyre', 'hirist', 'wellfound', 'mnc'] },
    })

    // Kick off Python scraper (non-blocking)
    fetch(`${scraperUrl}/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.SCRAPER_API_KEY! },
      body: JSON.stringify({ sources: null }),
    }).then(async (r) => {
      const data = await r.json()
      await prisma.scraperRun.update({
        where: { id: run.id },
        data: { status: 'COMPLETED', completedAt: new Date(), jobsFound: data.total || 0 },
      })
    }).catch(async (e) => {
      await prisma.scraperRun.update({ where: { id: run.id }, data: { status: 'FAILED', completedAt: new Date() } })
      console.error('Scraper trigger failed:', e)
    })

    return NextResponse.json({ runId: run.id, message: 'Scraper started' })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to start scraper' }, { status: 500 })
  }
}
