/**
 * Deterministic, explainable job-match scoring.
 *
 * Every job gets a 0-100 score with a structured breakdown of WHY. The user
 * sees the breakdown in the job detail panel so they trust the system.
 *
 * Inputs:
 *   - the scraped job (title, location, description, source, etc.)
 *   - the user's Profile (years exp, skills, locations, industries, etc.)
 *
 * Output: { score: 0-100, reasons: { factor: { weight, points, max, detail }}, notes: string }
 *
 * Design notes:
 *   - Pure function; no I/O or DB calls. Tested with unit tests.
 *   - Returns reasonable defaults if Profile is missing — a job still gets
 *     a baseline score so the user isn't blocked from auto-apply.
 *   - The score is deterministic (no AI/LLM call) so it's predictable and
 *     debuggable. AI scoring can layer on top later via matchNotes.
 */

export interface ScoringProfile {
  yearsExperience: number | null
  skills: string[]
  preferredLocations: string[]
  preferredIndustries: string[]
  remoteOnly: boolean
}

export interface ScoringJob {
  title: string
  company: string
  location: string | null
  description: string | null
  roleType: string
  source: string
}

interface FactorScore {
  weight: number   // max points this factor contributes
  points: number   // points actually awarded
  max: number      // alias for weight, kept for UI clarity
  detail: string   // human-readable why
}

export interface ScoringResult {
  score: number
  reasons: Record<string, FactorScore>
  notes: string
}

const SENIOR_KEYWORDS = [
  'director','vp','vice president','head of','chief','principal','staff',
  ' lead',' sr.',' sr ','senior','snr','group product','gpm',
]

const REMOTE_MARKERS  = ['remote','anywhere','work from home','wfh']
const INDIA_MARKERS   = [
  'india','bengaluru','bangalore','mumbai','delhi','ncr','noida','gurgaon',
  'gurugram','hyderabad','pune','chennai','kolkata','ahmedabad','kochi',
]

const ATS_RELIABLE_SOURCES = ['ats:greenhouse','ats:lever','ats:ashby']

export function scoreJob(job: ScoringJob, profile: ScoringProfile | null): ScoringResult {
  const titleLc       = (job.title || '').toLowerCase()
  const locationLc    = (job.location || '').toLowerCase()
  const descriptionLc = (job.description || '').toLowerCase()

  const reasons: Record<string, FactorScore> = {}

  // ── 1. Title relevance (max 30) ──────────────────────────────────────────
  // We already filter by title in the scraper, so a job reaching scoring is
  // at least loosely relevant. This factor distinguishes "Product Manager"
  // (perfect) from "Senior Product Manager" (irrelevant if we want IC) from
  // "Product Owner" (close enough).
  let titlePoints = 0
  let titleDetail = ''
  if (titleLc.includes('product manager')) {
    titlePoints = 30; titleDetail = 'Exact "Product Manager" match'
  } else if (titleLc.includes('associate product manager') || titleLc.includes('apm')) {
    titlePoints = 30; titleDetail = 'Exact APM match'
  } else if (titleLc.includes('program manager')) {
    titlePoints = 28; titleDetail = 'Program Manager match'
  } else if (titleLc.includes('project manager')) {
    titlePoints = 28; titleDetail = 'Project Manager match'
  } else if (titleLc.includes('business analyst')) {
    titlePoints = 28; titleDetail = 'Business Analyst match'
  } else if (titleLc.includes('product owner')) {
    titlePoints = 24; titleDetail = 'Product Owner — closely related'
  } else {
    titlePoints = 10; titleDetail = 'Loose keyword match'
  }
  // Penalise senior-level titles (they want experience, we want IC)
  if (SENIOR_KEYWORDS.some(k => titleLc.includes(k))) {
    titlePoints = Math.max(0, titlePoints - 15)
    titleDetail += ' (senior-level penalty applied)'
  }
  reasons.title = { weight: 30, points: titlePoints, max: 30, detail: titleDetail }

  // ── 2. Location fit (max 20) ─────────────────────────────────────────────
  // Three tiers: matches user's preferred location > India/remote > unknown.
  let locPoints = 0
  let locDetail = ''
  if (!locationLc) {
    locPoints = 8
    locDetail = 'Location not specified'
  } else {
    const isRemote     = REMOTE_MARKERS.some(m => locationLc.includes(m))
    const isIndia      = INDIA_MARKERS.some(m => locationLc.includes(m))
    const userPrefHit  = profile?.preferredLocations.some(p => p && locationLc.includes(p.toLowerCase()))

    if (userPrefHit) {
      locPoints = 20; locDetail = `Matches your preferred location: ${job.location}`
    } else if (isRemote) {
      locPoints = profile?.remoteOnly ? 20 : 16
      locDetail = profile?.remoteOnly ? 'Remote (you prefer remote)' : 'Remote-friendly'
    } else if (isIndia) {
      locPoints = profile?.remoteOnly ? 6 : 14
      locDetail = profile?.remoteOnly ? 'India-based (you prefer remote)' : 'India-based'
    } else {
      locPoints = 4
      locDetail = `Outside India: ${job.location}`
    }
  }
  reasons.location = { weight: 20, points: locPoints, max: 20, detail: locDetail }

  // ── 3. Skills overlap (max 25) ───────────────────────────────────────────
  // Substring-match each profile skill against the job description.
  let skillPoints = 0
  let skillDetail = ''
  if (!profile || profile.skills.length === 0) {
    skillPoints = 12
    skillDetail = 'No profile skills set — neutral score'
  } else if (!descriptionLc) {
    skillPoints = 8
    skillDetail = 'Job has no description to match skills against'
  } else {
    const matched = profile.skills.filter(s => s && descriptionLc.includes(s.toLowerCase()))
    const ratio   = matched.length / Math.max(1, profile.skills.length)
    skillPoints   = Math.round(25 * Math.min(1, ratio * 1.5))  // 67% match → full score
    skillDetail   = matched.length > 0
      ? `${matched.length}/${profile.skills.length} skills match: ${matched.slice(0, 5).join(', ')}${matched.length > 5 ? '…' : ''}`
      : `0/${profile.skills.length} skills found in description`
  }
  reasons.skills = { weight: 25, points: skillPoints, max: 25, detail: skillDetail }

  // ── 4. Industry fit (max 10) ─────────────────────────────────────────────
  let indPoints = 0
  let indDetail = ''
  if (!profile || profile.preferredIndustries.length === 0) {
    indPoints = 5
    indDetail = 'No preferred industries set'
  } else {
    const haystack = `${descriptionLc} ${(job.company || '').toLowerCase()}`
    const matches  = profile.preferredIndustries.filter(i => i && haystack.includes(i.toLowerCase()))
    if (matches.length > 0) {
      indPoints = 10; indDetail = `Matches industry: ${matches.join(', ')}`
    } else {
      indPoints = 3; indDetail = 'No industry signal in description'
    }
  }
  reasons.industry = { weight: 10, points: indPoints, max: 10, detail: indDetail }

  // ── 5. Source quality (max 10) ───────────────────────────────────────────
  // ATS feeds are higher signal than CSS-scraped boards.
  let srcPoints = 0
  let srcDetail = ''
  if (ATS_RELIABLE_SOURCES.includes(job.source)) {
    srcPoints = 10; srcDetail = `${job.source} is a reliable ATS feed`
  } else if (job.source === 'linkedin') {
    srcPoints = 8;  srcDetail = 'LinkedIn — high signal'
  } else if (job.source === 'mnc') {
    srcPoints = 6;  srcDetail = 'MNC career-page scrape'
  } else {
    srcPoints = 5;  srcDetail = 'Standard job-board source'
  }
  reasons.source = { weight: 10, points: srcPoints, max: 10, detail: srcDetail }

  // ── 6. Description depth (max 5) ─────────────────────────────────────────
  // Very thin descriptions are usually low-effort listings or aggregator dupes.
  let descPoints = 0
  let descDetail = ''
  const descLen = (job.description || '').length
  if (descLen >= 800) {
    descPoints = 5; descDetail = 'Detailed description'
  } else if (descLen >= 300) {
    descPoints = 3; descDetail = 'Moderate description'
  } else if (descLen > 0) {
    descPoints = 1; descDetail = 'Thin description'
  } else {
    descPoints = 0; descDetail = 'No description'
  }
  reasons.description = { weight: 5, points: descPoints, max: 5, detail: descDetail }

  // ── Total ────────────────────────────────────────────────────────────────
  const score = Object.values(reasons).reduce((acc, r) => acc + r.points, 0)

  // One-line human summary for matchNotes
  const top3 = Object.entries(reasons)
    .sort((a, b) => b[1].points - a[1].points)
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${v.points}/${v.max}`)
    .join(' · ')
  const notes = `Score ${score}/100 — top factors: ${top3}`

  return { score, reasons, notes }
}


/**
 * Quality gate — return null if the job should be saved, or a short reason
 * string if it should be dropped.
 *
 * Hard drops (the only reasons a job is rejected):
 *   - Missing essentials (no title or no sourceUrl)
 *   - Stale: postedAt is more than 60 days ago
 *   - Senior-level title that slipped past the role classifier
 *
 * Soft cases we intentionally do NOT drop on anymore:
 *   - Missing company. IIMJobs and Hirist often don't expose the company
 *     name on the search-results card (you click through to see it). When
 *     we dropped on `missing-company`, an entire IIMJobs run of 106 jobs
 *     was silently discarded. The UI gracefully renders an empty company
 *     field, so it's better to keep the row and let the user click through.
 */
export function qualityGateReason(
  job: { title: string; company: string; description: string | null; postedAt: Date | null; sourceUrl: string }
): string | null {
  if (!job.title?.trim() || !job.sourceUrl?.trim()) return 'missing-essentials'

  if (job.postedAt) {
    const ageDays = (Date.now() - job.postedAt.getTime()) / (1000 * 60 * 60 * 24)
    if (ageDays > 60) return `stale-${Math.round(ageDays)}d`
  }

  const titleLc = job.title.toLowerCase()
  if (SENIOR_KEYWORDS.some(k => titleLc.includes(k))) return 'senior-level'

  return null
}
