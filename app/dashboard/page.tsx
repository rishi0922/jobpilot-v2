'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession, signOut } from 'next-auth/react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid, Legend, PieChart, Pie, Cell
} from 'recharts'
import {
  Search, RefreshCw, Settings, BrainCircuit, ChevronRight,
  Briefcase, Send, Clock, Trophy, AlertCircle, TrendingUp,
  Zap, Eye, RotateCcw, Filter, ChevronDown, ThumbsUp, ThumbsDown,
  X, ExternalLink, CheckCircle2, AlertTriangle, MapPin, Building2,
  LogOut, ShieldCheck,
} from 'lucide-react'

const ROLE_LABELS: Record<string, string> = {
  APM: 'APM', PM: 'PM', PROJECT_MANAGER: 'Project Mgr',
  PROGRAM_MANAGER: 'Program Mgr', BUSINESS_ANALYST: 'BA'
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  FOUND:      { label: 'Found',      color: '#6366f1', bg: '#ede9fe' },
  QUEUED:     { label: 'Queued',     color: '#8b5cf6', bg: '#ede9fe' },
  APPLIED:    { label: 'Applied',    color: '#0ea5e9', bg: '#e0f2fe' },
  IN_REVIEW:  { label: 'In Review',  color: '#f59e0b', bg: '#fef3c7' },
  INTERVIEW:  { label: 'Interview',  color: '#10b981', bg: '#d1fae5' },
  REJECTED:   { label: 'Rejected',   color: '#ef4444', bg: '#fee2e2' },
  FAILED:     { label: 'Failed',     color: '#f97316', bg: '#ffedd5' },
  SKIPPED:    { label: 'Skipped',    color: '#94a3b8', bg: '#f1f5f9' },
}

const SOURCE_COLORS = ['#6366f1','#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6','#f97316']

interface SourceHealth {
  source: string
  found: number
  kept: number
  dropped: number
  skipped: number
  ok: boolean
}

interface DashboardStats {
  totalFound: number
  totalApplied: number
  inReview: number
  interviews: number
  failed: number
  successRate: number
  byRole: Array<{ role: string; found?: number; applied?: number; interviews?: number; count?: number }>
  bySource: Array<{ source: string; count: number }>
  byStatus: Array<{ status: string; count: number }>
  recentActivity: Array<{ date: string; applied: number; found: number }>
  lastScraperRun: string | null
  scraperStatus: 'idle' | 'running' | 'failed' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  sourceHealth: SourceHealth[]
  lastRunAt: string | null
}

const EMPTY_STATS: DashboardStats = {
  totalFound: 0, totalApplied: 0, inReview: 0, interviews: 0, failed: 0,
  successRate: 0,
  byRole: [], bySource: [], byStatus: [],
  recentActivity: [],
  lastScraperRun: null,
  scraperStatus: 'idle',
  sourceHealth: [],
  lastRunAt: null,
}

interface Job {
  id: string
  title: string
  company: string
  location: string | null
  source: string
  roleType: string
  status: string
  matchScore: number | null
  matchNotes?: string | null
  feedback?: 'UP' | 'DOWN' | null
  appliedAt: string | null
  scrapedAt: string
  sourceUrl: string
  cvUsed: string | null
  applyMode: string
}

interface MatchReason {
  weight: number
  points: number
  max: number
  detail: string
}

interface JobDetail extends Job {
  description: string | null
  matchReasons: Record<string, MatchReason> | null
  postedAt: string | null
  salary: string | null
  applications?: Array<{ id: string; status: string; submittedAt: string; errorLog: string | null; responseNote: string | null }>
}

// ---- Components ----

function StatCard({ label, value, sub, color, onClick }: { label: string; value: string | number; sub?: string; color?: string; onClick?: () => void }) {
  const clickable = typeof onClick === 'function'
  return (
    <div
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      className={`bg-white rounded-2xl p-4 border border-surface-200 flex flex-col gap-1.5 animate-slide-up ${
        clickable ? 'cursor-pointer hover:border-brand-300 hover:shadow-sm transition-all' : ''
      }`}
    >
      {/* Label — small, semibold, more tracked-out so it reads as an
          editorial caption rather than running into the value below. */}
      <p className="text-[10px] text-ink-tertiary font-semibold tracking-[0.08em] uppercase">{label}</p>
      {/* Value — bumped one step (text-3xl → text-4xl), tabular-nums so the
          digit columns line up across cards (no jitter when 7 vs 12 vs 124),
          tracking-tight + leading-none to keep the number visually compact
          and authoritative rather than airy. */}
      <p className={`text-4xl font-semibold tabular-nums tracking-tight leading-none ${color || 'text-ink-primary'}`}>{value}</p>
      {/* Sub — slightly smaller than the label so the hierarchy is
          label > value > sub, even though label and sub are both small.
          font-medium gives it just enough weight to not vanish. */}
      {sub && <p className="text-[11px] text-ink-tertiary font-medium">{sub}</p>}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] || { label: status, color: '#94a3b8', bg: '#f1f5f9' }
  return (
    <span className="badge" style={{ background: cfg.bg, color: cfg.color }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.color, display: 'inline-block' }} />
      {cfg.label}
    </span>
  )
}

function MatchScore({ score }: { score: number | null }) {
  if (score === null) return <span className="text-ink-muted text-xs">—</span>
  const color = score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444'
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1.5 rounded-full bg-surface-200 overflow-hidden">
        <div style={{ width: `${score}%`, background: color, height: '100%', borderRadius: 99, transition: 'width 0.5s ease' }} />
      </div>
      <span style={{ color, fontSize: 11, fontWeight: 600 }}>{score}</span>
    </div>
  )
}

// ── Applications history ──
interface AppliedRole {
  id: string
  jobId: string | null
  title: string
  company: string
  location: string | null
  source: string
  sourceUrl: string
  roleType: string
  jobDescription: string | null
  matchScoreAtApply: number | null
  cvUsed: string | null
  outcome: 'APPLIED' | 'IN_REVIEW' | 'INTERVIEW' | 'OFFER' | 'REJECTED' | 'WITHDRAWN'
  outcomeNotes: string | null
  appliedAt: string
  updatedAt: string
}

const OUTCOME_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  APPLIED:   { label: 'Applied',    color: '#4f46e5', bg: '#eef2ff' },
  IN_REVIEW: { label: 'In review',  color: '#b45309', bg: '#fffbeb' },
  INTERVIEW: { label: 'Interview',  color: '#0e7490', bg: '#ecfeff' },
  OFFER:     { label: 'Offer',      color: '#15803d', bg: '#f0fdf4' },
  REJECTED:  { label: 'Rejected',   color: '#b91c1c', bg: '#fef2f2' },
  WITHDRAWN: { label: 'Withdrawn',  color: '#6b7280', bg: '#f3f4f6' },
}

// ── CV Analysis types ──
interface CvOption {
  id: string
  roleType: string
  fileName: string
  version: number
}

interface CvAnalysisResult {
  matchScore: number
  strengths: string[]
  gaps: string[]
  suggestions: string[]
  keywords: string[]
  summary: string
  recommendedCvRole?: string
}

interface PostApplicationInsight {
  successPatterns: string[]
  failPatterns: string[]
  topPerformingRoles: string[]
  cvImprovements: string[]
  keywordsThatWork: string[]
  applied?: number
}

export default function Dashboard() {
  const { data: session } = useSession()
  const [stats, setStats] = useState<DashboardStats>(EMPTY_STATS)
  const [jobs, setJobs] = useState<Job[]>([])
  const [applications, setApplications] = useState<AppliedRole[]>([])
  const [autoApply, setAutoApply] = useState(true)
  // 'mnc' is a synthetic tab — same UI as 'jobs' but pre-filtered to source='mnc'.
  const [activeTab, setActiveTab] = useState<'overview' | 'jobs' | 'mnc' | 'applications' | 'analysis'>('overview')
  const [filterRole, setFilterRole] = useState('')
  const [filterSource, setFilterSource] = useState('')
  const [filterCompany, setFilterCompany] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  // Scraped-date filter: 'all' | 'today' | '7d' | '30d'
  const [filterScrapedWindow, setFilterScrapedWindow] = useState<'all' | 'today' | '7d' | '30d'>('all')
  const [search, setSearch] = useState('')
  // Total matching rows on the server, so we can show "Showing X of Y" and
  // hide the Load-more button once we've fetched everything.
  const [jobsTotal, setJobsTotal] = useState(0)
  // Client-side pagination — bumps the server `limit` to load more rows.
  // Default page size is generous so a typical run (200-300 jobs) fits in
  // one fetch; users can click Load-more if they have more.
  const [jobsPageSize, setJobsPageSize] = useState(300)
  const [scraperRunning, setScraperRunning] = useState(false)
  const [scraperMessage, setScraperMessage] = useState<string | null>(null)
  const [loadingData, setLoadingData] = useState(true)
  const [showInsights, setShowInsights] = useState(false)
  const [detailJobId, setDetailJobId] = useState<string | null>(null)
  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  // Sort state for the jobs list — defaults to newest scraped first so the
  // freshest results are always at the top. Users can switch to match-score
  // sort from the dropdown.
  const [sortBy, setSortBy] = useState<'matchScore' | 'scrapedAt' | 'company'>('scrapedAt')
  // Client-side pagination of the filtered list — 50 cards per page.
  const [currentPage, setCurrentPage] = useState(1)
  const JOBS_PER_PAGE = 50
  // True while a bulk-retry of all FAILED jobs is in flight.
  const [retryingAll, setRetryingAll] = useState(false)

  // ── CV Analysis state ──
  // Available CVs loaded from /api/resumes. Empty until the analysis tab is
  // opened for the first time.
  const [cvOptions, setCvOptions]           = useState<CvOption[]>([])
  const [cvLoadError, setCvLoadError]       = useState<string | null>(null)
  // Selected CV id and the pasted JD content.
  const [selectedCvId, setSelectedCvId]     = useState<string>('')
  const [analysisJd, setAnalysisJd]         = useState('')
  // Result + loading/error states for the pre-application analysis call.
  const [analyzing, setAnalyzing]           = useState(false)
  const [analysisResult, setAnalysisResult] = useState<CvAnalysisResult | null>(null)
  const [analysisError, setAnalysisError]   = useState<string | null>(null)
  // Post-application insights — generated on-demand from past Applied/Rejected/etc rows.
  const [insightsLoading, setInsightsLoading] = useState(false)
  const [insights, setInsights]               = useState<PostApplicationInsight | null>(null)
  const [insightsError, setInsightsError]     = useState<string | null>(null)

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch('/api/stats', { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setStats(prev => ({ ...prev, ...data }))
    } catch (err) {
      console.error('Failed to load stats', err)
    }
  }, [])

  const loadJobs = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: String(jobsPageSize) })
      if (filterRole) params.set('roleType', filterRole)
      if (filterSource) params.set('source', filterSource.toLowerCase())
      if (filterStatus) params.set('status', filterStatus)
      // Scraped-date window → ISO timestamp passed to the API as scrapedAfter.
      if (filterScrapedWindow !== 'all') {
        const now = new Date()
        const after = new Date(now)
        if (filterScrapedWindow === 'today') {
          after.setHours(0, 0, 0, 0)
        } else if (filterScrapedWindow === '7d') {
          after.setDate(now.getDate() - 7)
        } else if (filterScrapedWindow === '30d') {
          after.setDate(now.getDate() - 30)
        }
        params.set('scrapedAfter', after.toISOString())
      }
      const res = await fetch(`/api/jobs?${params}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setJobs(data.jobs || [])
      setJobsTotal(typeof data.total === 'number' ? data.total : (data.jobs?.length || 0))
    } catch (err) {
      console.error('Failed to load jobs', err)
    }
  }, [filterRole, filterSource, filterStatus, filterScrapedWindow, jobsPageSize])

  useEffect(() => {
    Promise.all([loadStats(), loadJobs()]).finally(() => setLoadingData(false))
    const interval = setInterval(() => {
      loadStats()
      if (activeTab === 'jobs') loadJobs()
    }, 30000)
    return () => clearInterval(interval)
  }, [loadStats, loadJobs, activeTab])

  useEffect(() => { loadJobs() }, [loadJobs])

  // Whenever the filter/search/sort inputs change, jump back to page 1 so the
  // user always sees results from the top of the new filter — otherwise the
  // page index can point past the end of the new (often shorter) list.
  useEffect(() => {
    setCurrentPage(1)
  }, [filterRole, filterSource, filterCompany, filterStatus, filterScrapedWindow, search, sortBy])

  const filteredJobs = jobs
    .filter(j => {
      const matchRole = !filterRole || j.roleType === filterRole
      const matchSource = !filterSource || j.source.toLowerCase() === filterSource.toLowerCase()
      const matchCompany = !filterCompany || (j.company || '').toLowerCase() === filterCompany.toLowerCase()
      const matchStatus = !filterStatus || j.status === filterStatus
      const matchSearch = !search || j.title.toLowerCase().includes(search.toLowerCase()) || (j.company || '').toLowerCase().includes(search.toLowerCase())
      return matchRole && matchSource && matchCompany && matchStatus && matchSearch
    })
    .sort((a, b) => {
      if (sortBy === 'matchScore') {
        // Highest score first; nulls sink to the bottom
        const ascore = a.matchScore ?? -1
        const bscore = b.matchScore ?? -1
        if (bscore !== ascore) return bscore - ascore
      } else if (sortBy === 'company') {
        // A-Z by company; empty/null company strings sink to the bottom
        const ac = (a.company || '').toLowerCase()
        const bc = (b.company || '').toLowerCase()
        if (!ac && bc) return 1
        if (ac && !bc) return -1
        const cmp = ac.localeCompare(bc)
        if (cmp !== 0) return cmp
      }
      // Tie-break / fallback: newest first
      return new Date(b.scrapedAt).getTime() - new Date(a.scrapedAt).getTime()
    })

  // When the user is on the MNC tab, further narrow the list to MNC sources
  // before pagination. Keeps all other UI logic (search, role/status filters,
  // pagination, retry) identical to the All-Jobs view.
  const tabFilteredJobs = activeTab === 'mnc'
    ? filteredJobs.filter(j => j.source === 'mnc')
    : filteredJobs

  // 50-per-page slice of the filtered/sorted list. `totalPages` is at least 1
  // so the pagination bar still renders sensibly on an empty list.
  const totalPages    = Math.max(1, Math.ceil(tabFilteredJobs.length / JOBS_PER_PAGE))
  const safePage      = Math.min(currentPage, totalPages)
  const pageStart     = (safePage - 1) * JOBS_PER_PAGE
  const pageEnd       = pageStart + JOBS_PER_PAGE
  const paginatedJobs = tabFilteredJobs.slice(pageStart, pageEnd)
  // Stats for the tab badge — how many MNC jobs are currently loaded.
  const mncCount      = jobs.filter(j => j.source === 'mnc').length

  const manualPendingJobs = jobs.filter(j => j.status === 'FOUND' && !autoApply)
  // FAILED jobs visible in the *currently loaded* set — bulk retry only acts
  // on what's loaded, so the user sees a count they can verify against the
  // page. (Server may have more FAILED jobs further back in time.)
  const failedJobsLoaded  = jobs.filter(j => j.status === 'FAILED')

  function toggleApplyMode() {
    setAutoApply(prev => !prev)
  }

  async function patchJob(jobId: string, patch: { status?: string; applyMode?: string }) {
    const res = await fetch('/api/jobs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: jobId, ...patch }),
    })
    if (!res.ok) throw new Error(`Update failed: ${res.status}`)
    return res.json()
  }

  async function handleManualApply(jobId: string) {
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: 'QUEUED' } : j))
    try {
      await patchJob(jobId, { status: 'QUEUED', applyMode: 'AUTO' })
      loadJobs()
    } catch (err) {
      console.error(err)
      loadJobs()
    }
  }

  /** Re-queue every FAILED job in the currently loaded set. Each is PATCHed
   *  to status=QUEUED with applyMode=AUTO so the apply-queue worker will
   *  pick it up on its next pass. We do them sequentially to avoid
   *  hammering Prisma/the DB with parallel writes on a small instance. */
  async function retryAllFailed() {
    if (failedJobsLoaded.length === 0 || retryingAll) return
    setRetryingAll(true)
    // Optimistic UI: flip all of them to QUEUED locally first.
    setJobs(prev => prev.map(j => j.status === 'FAILED' ? { ...j, status: 'QUEUED' } : j))
    try {
      for (const fj of failedJobsLoaded) {
        try {
          await patchJob(fj.id, { status: 'QUEUED', applyMode: 'AUTO' })
        } catch (e) {
          console.error(`retry failed for job ${fj.id}`, e)
        }
      }
    } finally {
      setRetryingAll(false)
      loadJobs()
      loadStats()
    }
  }

  async function handleSkip(jobId: string) {
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: 'SKIPPED' } : j))
    try {
      await patchJob(jobId, { status: 'SKIPPED' })
    } catch (err) {
      console.error(err)
      loadJobs()
    }
  }

  // Manually mark a job as applied — for when the user applied outside the
  // auto-applicator (directly on the company site, an email referral, etc.).
  // Sets applyMode=MANUAL so the dashboard can later distinguish auto-applied
  // jobs from manually-tracked ones. PATCH /api/jobs sets `appliedAt`
  // server-side whenever status becomes APPLIED.
  async function handleMarkApplied(jobId: string) {
    const nowIso = new Date().toISOString()
    setJobs(prev => prev.map(j =>
      j.id === jobId ? { ...j, status: 'APPLIED', appliedAt: nowIso } : j
    ))
    try {
      await patchJob(jobId, { status: 'APPLIED', applyMode: 'MANUAL' })
      loadStats()
    } catch (err) {
      console.error(err)
      loadJobs()
    }
  }

  async function setFeedback(jobId: string, value: 'UP' | 'DOWN' | null) {
    // Toggle: if user clicks the same button again, clear it.
    const currentJob = jobs.find(j => j.id === jobId)
    const next = currentJob?.feedback === value ? null : value
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, feedback: next } : j))
    try {
      await fetch('/api/jobs/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: jobId, feedback: next }),
      })
    } catch (err) {
      console.error('Feedback save failed', err)
      loadJobs()  // revert
    }
  }

  async function openDetail(jobId: string) {
    setDetailJobId(jobId)
    setDetail(null)
    setDetailLoading(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`Status ${res.status}`)
      const data: JobDetail = await res.json()
      setDetail(data)
    } catch (err) {
      console.error('Failed to load job detail', err)
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }

  function closeDetail() {
    setDetailJobId(null)
    setDetail(null)
  }

  /** Load the list of uploaded CVs once when the user opens the Analysis tab.
   *  Auto-selects the first CV so the user can start analyzing without an
   *  extra click. */
  const loadCvOptions = useCallback(async () => {
    setCvLoadError(null)
    try {
      const res = await fetch('/api/resumes', { cache: 'no-store' })
      if (!res.ok) {
        setCvLoadError(`Could not load CVs (HTTP ${res.status})`)
        return
      }
      const data = await res.json()
      const list: CvOption[] = data.cvs || []
      setCvOptions(list)
      if (list.length > 0 && !selectedCvId) {
        setSelectedCvId(list[0].id)
      }
    } catch (err: any) {
      setCvLoadError(err?.message || 'Failed to load CVs')
    }
  }, [selectedCvId])

  useEffect(() => {
    if (activeTab === 'analysis' && cvOptions.length === 0 && !cvLoadError) {
      loadCvOptions()
    }
  }, [activeTab, cvOptions.length, cvLoadError, loadCvOptions])

  // ── Applications history ──
  const loadApplications = useCallback(async () => {
    try {
      const res = await fetch('/api/applications', { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setApplications(data.rows || [])
    } catch (err) {
      console.error('Failed to load applications', err)
    }
  }, [])

  // Load applications whenever that tab is opened (and once on mount so the
  // tab count badge is populated).
  useEffect(() => { loadApplications() }, [loadApplications])
  useEffect(() => {
    if (activeTab === 'applications') loadApplications()
  }, [activeTab, loadApplications])

  // Update an application's outcome (and optionally notes), then refresh.
  async function updateApplicationOutcome(id: string, outcome: string, outcomeNotes?: string) {
    try {
      await fetch('/api/applications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, outcome, ...(outcomeNotes !== undefined ? { outcomeNotes } : {}) }),
      })
      await loadApplications()
    } catch (err) {
      console.error('Failed to update application', err)
    }
  }

  /** Pre-application analysis. Sends the selected CV id + pasted JD to
   *  the backend, which calls Claude with the PDF attached. */
  async function runCvAnalysis() {
    setAnalysisError(null)
    setAnalysisResult(null)
    if (!analysisJd.trim()) {
      setAnalysisError('Paste a job description first.')
      return
    }
    if (!selectedCvId) {
      setAnalysisError('Upload at least one CV in Settings, then refresh.')
      return
    }
    const cv = cvOptions.find(c => c.id === selectedCvId)
    setAnalyzing(true)
    try {
      const res = await fetch('/api/resumes/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type:           'pre_application',
          cvId:           selectedCvId,
          jobDescription: analysisJd,
          roleType:       cv?.roleType || 'PM',
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setAnalysisError(data.error || `Analysis failed (HTTP ${res.status})`)
      } else {
        setAnalysisResult(data)
      }
    } catch (err: any) {
      setAnalysisError(err?.message || 'Network error')
    } finally {
      setAnalyzing(false)
    }
  }

  /** Post-application insights — patterns across applied jobs. */
  async function refreshInsights() {
    setInsightsError(null)
    setInsightsLoading(true)
    try {
      const res = await fetch('/api/resumes/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'post_application' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setInsightsError(data.error || `Insights failed (HTTP ${res.status})`)
      } else {
        setInsights(data)
      }
    } catch (err: any) {
      setInsightsError(err?.message || 'Network error')
    } finally {
      setInsightsLoading(false)
    }
  }

  async function triggerScraper() {
    setScraperRunning(true)
    setScraperMessage(null)
    try {
      const res = await fetch('/api/scraper/trigger', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setScraperMessage(data.error || `Trigger failed (${res.status})`)
      } else {
        setScraperMessage(`Scraper started — run ${data.runId?.slice(0, 8) || ''}. Jobs appear as they're scraped.`)
        // Refresh stats every 10s for the next 2 minutes to pick up incoming jobs.
        let ticks = 0
        const poll = setInterval(() => {
          loadStats()
          loadJobs()
          if (++ticks >= 12) clearInterval(poll)
        }, 10000)
      }
    } catch (err: any) {
      setScraperMessage(`Network error: ${err?.message || err}`)
    } finally {
      setScraperRunning(false)
      setTimeout(() => setScraperMessage(null), 8000)
    }
  }

  const tabs = [
    { id: 'overview',     label: 'Overview' },
    { id: 'jobs',         label: `All Jobs (${filteredJobs.length})` },
    { id: 'mnc',          label: `MNC Jobs (${mncCount})` },
    { id: 'applications', label: `Applications (${applications.length})` },
    { id: 'analysis',     label: 'CV Analysis' },
  ]

  return (
    <div className="min-h-screen bg-surface-50">
      {/* Header */}
      <header className="bg-white border-b border-surface-200 sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-brand-600 flex items-center justify-center">
              <Zap size={14} color="white" />
            </div>
            <span className="font-display text-lg text-ink-primary">JobPilot</span>
          </div>

          <div className="flex items-center gap-3">
            {/* Live indicator */}
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${scraperRunning ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`} style={{ boxShadow: `0 0 0 3px ${scraperRunning ? '#fef3c7' : '#d1fae5'}` }} />
              <span className="text-xs text-ink-tertiary hidden sm:block">
                {scraperRunning
                  ? 'Scraping…'
                  : stats.lastScraperRun
                    ? `Last run: ${new Date(stats.lastScraperRun).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                    : 'No runs yet'}
              </span>
            </div>

            {/* Auto/Manual toggle */}
            <div className="flex items-center gap-2 bg-surface-100 rounded-xl px-3 py-1.5 border border-surface-200">
              <span className="text-xs text-ink-secondary font-medium">{autoApply ? 'Auto Apply' : 'Manual'}</span>
              <label className="toggle-switch" style={{ width: 36, height: 20 }}>
                <input type="checkbox" checked={autoApply} onChange={toggleApplyMode} />
                <span className="toggle-slider" />
              </label>
            </div>

            <button onClick={triggerScraper} disabled={scraperRunning}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-600 text-white rounded-xl text-xs font-medium hover:bg-brand-700 transition-colors disabled:opacity-50">
              <RefreshCw size={12} className={scraperRunning ? 'animate-spin' : ''} />
              <span className="hidden sm:block">Run scraper</span>
            </button>

            <a href="/settings" className="p-2 rounded-xl hover:bg-surface-100 text-ink-tertiary transition-colors" title="Settings">
              <Settings size={16} />
            </a>

            {/* Admin console — only shown to ADMIN users. The role is on the
                JWT (set by lib/auth.ts callbacks) so this is just a UI hint;
                /api/admin/* routes enforce the role on the server side too. */}
            {(session?.user as any)?.role === 'ADMIN' && (
              <a href="/admin" className="p-2 rounded-xl hover:bg-surface-100 text-ink-tertiary transition-colors" title="Admin">
                <ShieldCheck size={16} />
              </a>
            )}

            {/* User identity + sign-out. The email tooltip is enough for now;
                a fuller user menu (profile, billing, etc.) can come later. */}
            {session?.user && (
              <button
                onClick={() => signOut({ callbackUrl: '/signin' })}
                className="p-2 rounded-xl hover:bg-surface-100 text-ink-tertiary transition-colors"
                title={`Sign out (${session.user.email || ''})`}
              >
                <LogOut size={16} />
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">

        {/* Scraper status banner */}
        {scraperMessage && (
          <div className="mb-5 bg-brand-50 border border-brand-200 rounded-2xl p-3 text-xs text-brand-800 animate-slide-down">
            {scraperMessage}
          </div>
        )}

        {/* Manual mode banner */}
        {!autoApply && manualPendingJobs.length > 0 && (
          <div className="mb-5 bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-center gap-3 animate-slide-down">
            <Eye size={18} className="text-amber-600 shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-800">Manual mode active</p>
              <p className="text-xs text-amber-600">{manualPendingJobs.length} jobs waiting for your approval below.</p>
            </div>
          </div>
        )}

        {/* Stat cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
          <StatCard label="Jobs found" value={stats.totalFound.toLocaleString()} sub={loadingData ? 'Loading…' : 'All time'} />
          <StatCard
            label="Applied"
            value={stats.totalApplied.toLocaleString()}
            sub={stats.totalFound > 0 ? `${Math.round((stats.totalApplied / stats.totalFound) * 100)}% of found` : '—'}
          />
          <StatCard label="In review" value={stats.inReview} color="text-amber-500" />
          <StatCard label="Interviews" value={stats.interviews} color="text-emerald-500" sub={`${stats.successRate}% rate`} />
          <StatCard
            label="Failed"
            value={stats.failed}
            color="text-red-400"
            sub={stats.failed > 0 ? 'Click to retry →' : 'All clean'}
            onClick={stats.failed > 0 ? () => {
              setActiveTab('jobs')
              setFilterStatus('FAILED')
            } : undefined}
          />
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-5 bg-surface-100 rounded-xl p-1 border border-surface-200">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id as any)}
              className={`flex-1 text-xs font-medium py-2 px-3 rounded-lg transition-all ${
                activeTab === t.id
                  ? 'bg-white text-brand-600 shadow-sm border border-surface-200'
                  : 'text-ink-tertiary hover:text-ink-secondary'
              }`}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ===== OVERVIEW TAB ===== */}
        {activeTab === 'overview' && (
          <div className="space-y-5 animate-fade-in">
            {/* Activity chart */}
            <div className="bg-white rounded-2xl border border-surface-200 p-5">
              <h2 className="text-sm font-semibold text-ink-primary mb-4">Daily activity</h2>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={stats.recentActivity} barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f3f9" />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#8b92a9' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#8b92a9' }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e4e7f0', fontSize: 12 }} />
                  <Bar dataKey="found" name="Found" fill="#e0e7ff" radius={[4,4,0,0]} />
                  <Bar dataKey="applied" name="Applied" fill="#6366f1" radius={[4,4,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              {/* By role */}
              <div className="bg-white rounded-2xl border border-surface-200 p-5">
                <h2 className="text-sm font-semibold text-ink-primary mb-4">By role type</h2>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={stats.byRole} layout="vertical" barGap={2}>
                    <XAxis type="number" tick={{ fontSize: 10, fill: '#8b92a9' }} axisLine={false} tickLine={false} />
                    <YAxis dataKey="role" type="category" tick={{ fontSize: 11, fill: '#4b5268' }} axisLine={false} tickLine={false} width={70} />
                    <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e4e7f0', fontSize: 12 }} />
                    <Bar dataKey="applied" name="Applied" fill="#6366f1" radius={[0,4,4,0]} />
                    <Bar dataKey="interviews" name="Interviews" fill="#10b981" radius={[0,4,4,0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* By source */}
              <div className="bg-white rounded-2xl border border-surface-200 p-5">
                <h2 className="text-sm font-semibold text-ink-primary mb-4">By source</h2>
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie data={stats.bySource} dataKey="count" nameKey="source" cx="50%" cy="50%" outerRadius={70} innerRadius={35} paddingAngle={2}>
                      {stats.bySource.map((_, i) => <Cell key={i} fill={SOURCE_COLORS[i % SOURCE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e4e7f0', fontSize: 12 }} />
                    <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Source health — last run breakdown */}
            {stats.sourceHealth.length > 0 && (
              <div className="bg-white rounded-2xl border border-surface-200 p-5">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h2 className="text-sm font-semibold text-ink-primary">Source health (last run)</h2>
                    <p className="text-xs text-ink-tertiary">
                      {stats.lastRunAt
                        ? `Run on ${new Date(stats.lastRunAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                        : 'Most recent scrape'}
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {stats.sourceHealth.map(s => (
                    <div key={s.source} className="flex items-center justify-between bg-surface-50 border border-surface-200 rounded-xl px-3 py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {s.ok
                          ? <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
                          : <AlertTriangle size={13} className="text-amber-500 shrink-0" />}
                        <span className="text-xs font-medium text-ink-primary truncate">{s.source}</span>
                      </div>
                      <div className="text-xs text-ink-tertiary whitespace-nowrap">
                        <span className="text-emerald-600 font-medium">{s.kept}</span>
                        <span className="text-ink-muted"> / {s.found} found</span>
                        {s.dropped > 0 && <span className="text-amber-600"> · {s.dropped} dropped</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ===== JOBS TAB (also reused for MNC tab — same UI, narrower source) ===== */}
        {(activeTab === 'jobs' || activeTab === 'mnc') && (
          <div className="animate-fade-in">
            {activeTab === 'mnc' && (
              <div className="mb-3 bg-brand-50 border border-brand-100 rounded-2xl px-4 py-2 text-xs text-brand-800 flex items-center gap-2">
                <Building2 size={13} />
                <span>
                  Showing only jobs scraped directly from MNC career sites.
                  {mncCount === 0 && ' No MNC jobs in the current load — run the scraper, then check back.'}
                </span>
              </div>
            )}
            {/* Filters row */}
            <div className="flex flex-wrap gap-2 mb-4">
              <div className="flex items-center gap-1.5 bg-white border border-surface-200 rounded-xl px-3 py-2 flex-1 min-w-[160px]">
                <Search size={13} className="text-ink-muted" />
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search title, company…"
                  className="bg-transparent text-xs text-ink-primary outline-none w-full placeholder:text-ink-muted" />
              </div>
              <select value={filterRole} onChange={e => setFilterRole(e.target.value)}
                className="bg-white border border-surface-200 rounded-xl px-3 py-2 text-xs text-ink-secondary outline-none">
                <option value="">All roles</option>
                {Object.entries(ROLE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              {activeTab !== 'mnc' && (
                <select value={filterSource} onChange={e => setFilterSource(e.target.value)}
                  className="bg-white border border-surface-200 rounded-xl px-3 py-2 text-xs text-ink-secondary outline-none">
                  <option value="">All sources</option>
                  {stats.bySource.map(s => <option key={s.source} value={s.source}>{s.source}</option>)}
                </select>
              )}
              <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                className="bg-white border border-surface-200 rounded-xl px-3 py-2 text-xs text-ink-secondary outline-none">
                <option value="">All statuses</option>
                {Object.entries(STATUS_CONFIG).map(([v, c]) => <option key={v} value={v}>{c.label}</option>)}
              </select>
              {/* Company dropdown — populated from the currently-loaded job list.
                  Sorted A-Z. Empty/blank company strings are skipped. */}
              <select value={filterCompany} onChange={e => setFilterCompany(e.target.value)}
                className="bg-white border border-surface-200 rounded-xl px-3 py-2 text-xs text-ink-secondary outline-none max-w-[180px]"
                title="Filter by company">
                <option value="">All companies</option>
                {Array.from(new Set(jobs.map(j => j.company).filter(Boolean) as string[]))
                  .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
                  .map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <select
                value={filterScrapedWindow}
                onChange={e => setFilterScrapedWindow(e.target.value as any)}
                className="bg-white border border-surface-200 rounded-xl px-3 py-2 text-xs text-ink-secondary outline-none"
                title="Filter by when the job was scraped"
              >
                <option value="all">Scraped: anytime</option>
                <option value="today">Scraped: today</option>
                <option value="7d">Scraped: last 7 days</option>
                <option value="30d">Scraped: last 30 days</option>
              </select>
              <select value={sortBy} onChange={e => setSortBy(e.target.value as any)}
                className="bg-white border border-surface-200 rounded-xl px-3 py-2 text-xs text-ink-secondary outline-none">
                <option value="matchScore">Sort: Best match</option>
                <option value="scrapedAt">Sort: Newest</option>
                <option value="company">Sort: Company A-Z</option>
              </select>
            </div>

            {/* Bulk-retry banner — only shown when the user is filtering to
                FAILED jobs (e.g. after clicking the Failed stat card). Gives
                a one-click way to re-queue everything that's loaded. */}
            {filterStatus === 'FAILED' && failedJobsLoaded.length > 0 && (
              <div className="mb-3 bg-red-50 border border-red-200 rounded-2xl p-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 animate-slide-down">
                <div className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-red-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-red-800">
                      {failedJobsLoaded.length} failed application{failedJobsLoaded.length === 1 ? '' : 's'} loaded
                    </p>
                    <p className="text-xs text-red-600">
                      Retry will re-queue them for the apply worker. You can also retry one-by-one with the per-card button.
                    </p>
                  </div>
                </div>
                <button
                  onClick={retryAllFailed}
                  disabled={retryingAll}
                  className="flex items-center gap-1.5 text-xs font-medium px-4 py-2 bg-red-600 text-white rounded-xl hover:bg-red-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  <RotateCcw size={12} className={retryingAll ? 'animate-spin' : ''} />
                  {retryingAll ? 'Retrying…' : `Retry all ${failedJobsLoaded.length}`}
                </button>
              </div>
            )}

            {/* Job cards — only the current page slice. */}
            <div className="space-y-2">
              {paginatedJobs.map((job, i) => (
                <div key={job.id}
                  className="job-card bg-white border border-surface-200 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center gap-3 hover:border-brand-300 transition-colors"
                  style={{ animationDelay: `${i * 30}ms` }}>
                  {/* Info — clicking opens the detail modal */}
                  <button type="button" onClick={() => openDetail(job.id)} className="flex-1 min-w-0 text-left">
                    <div className="flex items-start gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-ink-primary leading-tight hover:text-brand-700">{job.title}</p>
                      {job.status === 'FOUND' && !autoApply && (
                        <span className="badge" style={{ background: '#fef3c7', color: '#d97706' }}>Needs approval</span>
                      )}
                    </div>
                    <p className="text-xs text-ink-tertiary mt-1">
                      {job.company || <span className="text-ink-muted italic">company hidden</span>} · {job.location || '—'} · <span className="text-brand-600">{job.source}</span>
                      <> · Scraped {new Date(job.scrapedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</>
                      {job.appliedAt && <> · Applied {new Date(job.appliedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</>}
                    </p>
                  </button>

                  {/* Right side */}
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-xs text-ink-muted bg-surface-100 px-2 py-1 rounded-lg">
                      {ROLE_LABELS[job.roleType]} CV
                    </span>
                    <MatchScore score={job.matchScore} />
                    <StatusBadge status={job.status} />

                    {/* 👍 / 👎 feedback */}
                    <div className="flex items-center">
                      <button onClick={() => setFeedback(job.id, 'UP')}
                        title="Good fit"
                        className={`p-1.5 rounded-lg transition-colors ${
                          job.feedback === 'UP'
                            ? 'text-emerald-600 bg-emerald-50'
                            : 'text-ink-muted hover:text-emerald-600 hover:bg-emerald-50'
                        }`}>
                        <ThumbsUp size={13} />
                      </button>
                      <button onClick={() => setFeedback(job.id, 'DOWN')}
                        title="Not a fit"
                        className={`p-1.5 rounded-lg transition-colors ${
                          job.feedback === 'DOWN'
                            ? 'text-red-600 bg-red-50'
                            : 'text-ink-muted hover:text-red-600 hover:bg-red-50'
                        }`}>
                        <ThumbsDown size={13} />
                      </button>
                    </div>

                    {/* Manual action buttons */}
                    {!autoApply && job.status === 'FOUND' && (
                      <div className="flex gap-1.5">
                        <button onClick={() => handleManualApply(job.id)}
                          className="flex items-center gap-1 text-xs px-3 py-1.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors">
                          <Send size={10} /> Apply
                        </button>
                        <button onClick={() => handleSkip(job.id)}
                          className="text-xs px-3 py-1.5 border border-surface-200 text-ink-secondary rounded-lg hover:bg-surface-100 transition-colors">
                          Skip
                        </button>
                      </div>
                    )}

                    {job.status === 'FAILED' && (
                      <button onClick={() => handleManualApply(job.id)}
                        className="flex items-center gap-1 text-xs px-2 py-1 border border-surface-200 text-ink-tertiary rounded-lg hover:bg-surface-100 transition-colors">
                        <RotateCcw size={10} /> Retry
                      </button>
                    )}

                    {/* "Mark applied" — for when the user has applied outside
                        the auto-applicator (direct on company site, referral,
                        etc.). Shown for any status where the application step
                        hasn't already happened. */}
                    {['FOUND', 'QUEUED', 'FAILED', 'SKIPPED'].includes(job.status) && (
                      <button onClick={() => handleMarkApplied(job.id)}
                        title="I applied to this job manually"
                        className="flex items-center gap-1 text-xs px-2 py-1 border border-sky-200 text-sky-700 bg-sky-50 rounded-lg hover:bg-sky-100 transition-colors">
                        <CheckCircle2 size={10} /> Mark applied
                      </button>
                    )}

                    <a href={job.sourceUrl} target="_blank" rel="noopener noreferrer"
                      title="Open original posting"
                      className="p-1.5 text-ink-muted hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors">
                      <ExternalLink size={14} />
                    </a>
                  </div>
                </div>
              ))}

              {tabFilteredJobs.length === 0 && (
                <div className="text-center py-16 text-ink-tertiary">
                  <Briefcase size={32} className="mx-auto mb-3 opacity-30" />
                  <p className="text-sm">
                    {activeTab === 'mnc' ? 'No MNC jobs match your filters' : 'No jobs match your filters'}
                  </p>
                </div>
              )}

              {/* Pagination footer.
                  - Left: "Showing X–Y of Z" describing the current page
                    against the filtered list, plus a Load-more link if the
                    server has rows we haven't fetched yet.
                  - Right: Previous / Page N of M / Next page controls. */}
              {tabFilteredJobs.length > 0 && (
                <div className="pt-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-ink-tertiary">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>
                      Showing{' '}
                      <span className="text-ink-secondary font-medium">{pageStart + 1}–{Math.min(pageEnd, tabFilteredJobs.length)}</span>
                      {' '}of <span className="text-ink-secondary font-medium">{tabFilteredJobs.length}</span>
                      {tabFilteredJobs.length !== jobs.length && (
                        <> filtered (<span className="text-ink-secondary font-medium">{jobs.length}</span> loaded)</>
                      )}
                      {' · '}<span className="text-ink-muted">{jobsTotal} total on server</span>
                    </span>
                    {jobs.length < jobsTotal && (
                      <button
                        onClick={() => setJobsPageSize(s => s + 300)}
                        className="text-brand-600 hover:underline font-medium"
                      >
                        Load {Math.min(300, jobsTotal - jobs.length)} more from server
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={safePage <= 1}
                      className="px-3 py-1.5 border border-surface-200 bg-white rounded-lg text-ink-secondary hover:bg-surface-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Previous
                    </button>
                    <span className="px-2 text-ink-tertiary">
                      Page <span className="text-ink-secondary font-medium">{safePage}</span> of <span className="text-ink-secondary font-medium">{totalPages}</span>
                    </span>
                    <button
                      onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                      disabled={safePage >= totalPages}
                      className="px-3 py-1.5 border border-surface-200 bg-white rounded-lg text-ink-secondary hover:bg-surface-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ===== APPLICATIONS TAB ===== */}
        {activeTab === 'applications' && (
          <div className="animate-fade-in">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-ink-primary">Applied roles</h2>
                <p className="text-xs text-ink-tertiary">
                  Permanent history of every role you&rsquo;ve applied to — kept even after the listing expires.
                </p>
              </div>
            </div>

            {applications.length === 0 ? (
              <div className="bg-white rounded-2xl border border-surface-200 p-10 text-center">
                <Send size={20} className="text-ink-muted mx-auto mb-2" />
                <p className="text-sm text-ink-secondary">No applications yet</p>
                <p className="text-xs text-ink-tertiary mt-1">
                  Mark a job as applied (or let auto-apply run) and it&rsquo;ll show up here.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {applications.map(a => {
                  const cfg = OUTCOME_CONFIG[a.outcome] || OUTCOME_CONFIG.APPLIED
                  return (
                    <div key={a.id} className="bg-white rounded-2xl border border-surface-200 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-sm font-semibold text-ink-primary truncate">{a.title}</h3>
                            {a.matchScoreAtApply != null && (
                              <span className="text-[10px] text-ink-tertiary">· {a.matchScoreAtApply} match at apply</span>
                            )}
                          </div>
                          <p className="text-xs text-ink-secondary mt-0.5">
                            <span className="inline-flex items-center gap-1"><Building2 size={11} />{a.company || '—'}</span>
                            {a.location && <span className="inline-flex items-center gap-1 ml-2"><MapPin size={11} />{a.location}</span>}
                          </p>
                          <p className="text-[10px] text-ink-muted mt-1">
                            {ROLE_LABELS[a.roleType] || a.roleType} · via {a.source} · applied{' '}
                            {new Date(a.appliedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                            {a.cvUsed && ` · CV: ${ROLE_LABELS[a.cvUsed] || a.cvUsed}`}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {a.sourceUrl && (
                            <a href={a.sourceUrl} target="_blank" rel="noopener noreferrer"
                              className="p-1.5 rounded-lg hover:bg-surface-100 text-ink-tertiary" title="Open listing">
                              <ExternalLink size={14} />
                            </a>
                          )}
                          {/* Outcome dropdown — updates the durable record */}
                          <select
                            value={a.outcome}
                            onChange={e => updateApplicationOutcome(a.id, e.target.value)}
                            className="rounded-lg border px-2 py-1 text-xs font-medium outline-none cursor-pointer"
                            style={{ color: cfg.color, background: cfg.bg, borderColor: cfg.bg }}
                          >
                            {Object.entries(OUTCOME_CONFIG).map(([v, c]) => (
                              <option key={v} value={v} style={{ color: '#0f1117', background: '#fff' }}>{c.label}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ===== CV ANALYSIS TAB ===== */}
        {activeTab === 'analysis' && (
          <div className="animate-fade-in space-y-5">

            {/* Pre-application analysis */}
            <div className="bg-white rounded-2xl border border-surface-200 p-5">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-7 h-7 rounded-lg bg-brand-100 flex items-center justify-center">
                  <BrainCircuit size={14} className="text-brand-600" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-ink-primary">Pre-application CV scorer</h2>
                  <p className="text-xs text-ink-tertiary">
                    Gemini reads your uploaded CV (PDF) and scores it against a job description
                  </p>
                </div>
              </div>

              {cvOptions.length === 0 && !cvLoadError && (
                <div className="text-xs text-ink-tertiary p-3 bg-surface-50 border border-surface-200 rounded-xl">
                  Loading your uploaded CVs…
                </div>
              )}

              {cvLoadError && (
                <div className="text-xs text-red-600 p-3 bg-red-50 border border-red-200 rounded-xl mb-3">
                  {cvLoadError}
                </div>
              )}

              {cvOptions.length === 0 && cvLoadError === null && !analyzing && (
                <div className="text-xs text-amber-700 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                  No CVs uploaded yet. Go to <a href="/settings" className="underline font-medium">Settings</a> and upload at least one CV (PDF) to get started.
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-ink-tertiary block mb-1.5">Paste job description</label>
                  <textarea
                    rows={8}
                    value={analysisJd}
                    onChange={e => setAnalysisJd(e.target.value)}
                    placeholder="Paste the full JD here…"
                    className="w-full text-xs border border-surface-200 rounded-xl p-3 outline-none focus:border-brand-400 resize-none text-ink-secondary placeholder:text-ink-muted"
                  />
                </div>
                <div className="flex flex-col">
                  <label className="text-xs text-ink-tertiary block mb-1.5">Select CV to score</label>
                  <select
                    value={selectedCvId}
                    onChange={e => setSelectedCvId(e.target.value)}
                    disabled={cvOptions.length === 0}
                    className="w-full text-xs border border-surface-200 rounded-xl px-3 py-2 outline-none mb-3 text-ink-secondary disabled:opacity-60"
                  >
                    {cvOptions.length === 0 && <option value="">— no CVs uploaded —</option>}
                    {cvOptions.map(c => (
                      <option key={c.id} value={c.id}>
                        {ROLE_LABELS[c.roleType] || c.roleType} — {c.fileName} (v{c.version})
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={runCvAnalysis}
                    disabled={analyzing || !analysisJd.trim() || !selectedCvId}
                    className="w-full bg-brand-600 text-white text-xs font-medium py-2.5 rounded-xl hover:bg-brand-700 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <BrainCircuit size={13} className={analyzing ? 'animate-pulse' : ''} />
                    {analyzing ? 'Analysing… (~10-30s)' : 'Analyse with AI'}
                  </button>
                  <p className="text-xs text-ink-muted mt-2 text-center">Uses Gemini · reads PDF directly</p>
                </div>
              </div>

              {analysisError && (
                <div className="mt-4 text-xs text-red-700 p-3 bg-red-50 border border-red-200 rounded-xl">
                  {analysisError}
                </div>
              )}

              {analysisResult && !analysisError && (
                <div className="mt-4 p-4 bg-emerald-50 border border-emerald-100 rounded-xl">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-semibold text-emerald-800">
                      Analysis result — {ROLE_LABELS[cvOptions.find(c => c.id === selectedCvId)?.roleType || ''] || 'Selected CV'}
                      {analysisResult.recommendedCvRole && ` · Best CV for this JD: ${ROLE_LABELS[analysisResult.recommendedCvRole] || analysisResult.recommendedCvRole}`}
                    </span>
                    <span className="text-2xl font-semibold" style={{
                      color: analysisResult.matchScore >= 80 ? '#10b981'
                           : analysisResult.matchScore >= 60 ? '#f59e0b'
                           : '#ef4444'
                    }}>
                      {analysisResult.matchScore}<span className="text-sm">/100</span>
                    </span>
                  </div>
                  {analysisResult.summary && (
                    <p className="text-xs text-ink-secondary mb-3 leading-relaxed">{analysisResult.summary}</p>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <p className="text-xs font-medium text-emerald-700 mb-1.5">Strengths</p>
                      {analysisResult.strengths.length === 0
                        ? <p className="text-xs text-ink-muted italic">None identified</p>
                        : analysisResult.strengths.map((s, i) => (
                            <p key={i} className="text-xs text-emerald-600 flex gap-1.5 mb-1"><span>✓</span>{s}</p>
                          ))
                      }
                    </div>
                    <div>
                      <p className="text-xs font-medium text-red-700 mb-1.5">Gaps</p>
                      {analysisResult.gaps.length === 0
                        ? <p className="text-xs text-ink-muted italic">None identified</p>
                        : analysisResult.gaps.map((s, i) => (
                            <p key={i} className="text-xs text-red-500 flex gap-1.5 mb-1"><span>✗</span>{s}</p>
                          ))
                      }
                    </div>
                    <div>
                      <p className="text-xs font-medium text-amber-700 mb-1.5">Add these keywords</p>
                      {analysisResult.keywords.length === 0
                        ? <p className="text-xs text-ink-muted italic">None suggested</p>
                        : analysisResult.keywords.map((k, i) => (
                            <span key={i} className="inline-block text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-lg mr-1 mb-1">{k}</span>
                          ))
                      }
                    </div>
                  </div>
                  {analysisResult.suggestions.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-emerald-200">
                      <p className="text-xs font-medium text-emerald-800 mb-1.5">Suggestions</p>
                      {analysisResult.suggestions.map((s, i) => (
                        <p key={i} className="text-xs text-emerald-700 mb-1">• {s}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Post-application insights */}
            <div className="bg-white rounded-2xl border border-surface-200 p-5">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-7 h-7 rounded-lg bg-emerald-100 flex items-center justify-center">
                  <TrendingUp size={14} className="text-emerald-600" />
                </div>
                <div className="flex-1">
                  <h2 className="text-sm font-semibold text-ink-primary">Post-application insights</h2>
                  <p className="text-xs text-ink-tertiary">What's working and what to change — based on your real outcomes</p>
                </div>
              </div>

              {!insights && !insightsLoading && !insightsError && (
                <div className="text-xs text-ink-tertiary p-3 bg-surface-50 border border-surface-200 rounded-xl">
                  Click "Generate insights" to have Claude analyse patterns across your applied jobs.
                </div>
              )}

              {insightsLoading && (
                <div className="text-xs text-ink-tertiary p-3 bg-surface-50 border border-surface-200 rounded-xl">
                  Analysing your application history… (~10-20s)
                </div>
              )}

              {insightsError && (
                <div className="text-xs text-red-700 p-3 bg-red-50 border border-red-200 rounded-xl">
                  {insightsError}
                </div>
              )}

              {insights && !insightsLoading && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div className="p-4 bg-emerald-50 border border-emerald-100 rounded-xl">
                    <p className="text-xs font-semibold text-emerald-800 mb-2">What's working</p>
                    {(insights.successPatterns || []).length === 0
                      ? <p className="text-xs text-ink-muted italic">Not enough applied/interview data yet</p>
                      : insights.successPatterns.map((s, i) => (
                          <p key={i} className="text-xs text-emerald-600 mb-1">→ {s}</p>
                        ))
                    }
                  </div>
                  <div className="p-4 bg-red-50 border border-red-100 rounded-xl">
                    <p className="text-xs font-semibold text-red-800 mb-2">What's not working</p>
                    {(insights.failPatterns || []).length === 0
                      ? <p className="text-xs text-ink-muted italic">No rejection patterns yet</p>
                      : insights.failPatterns.map((s, i) => (
                          <p key={i} className="text-xs text-red-500 mb-1">✗ {s}</p>
                        ))
                    }
                  </div>
                  <div className="p-4 bg-brand-50 border border-brand-100 rounded-xl">
                    <p className="text-xs font-semibold text-brand-800 mb-2">CV improvements</p>
                    {(insights.cvImprovements || []).length === 0
                      ? <p className="text-xs text-ink-muted italic">No suggestions yet</p>
                      : insights.cvImprovements.map((s, i) => (
                          <p key={i} className="text-xs text-brand-600 mb-1">• {s}</p>
                        ))
                    }
                  </div>
                </div>
              )}

              <button
                onClick={refreshInsights}
                disabled={insightsLoading}
                className="mt-4 w-full sm:w-auto text-xs font-medium px-4 py-2 border border-surface-200 rounded-xl text-ink-secondary hover:bg-surface-100 transition-colors flex items-center gap-2 disabled:opacity-60"
              >
                <BrainCircuit size={13} className={insightsLoading ? 'animate-pulse' : ''} />
                {insightsLoading ? 'Generating…' : insights ? 'Regenerate insights' : 'Generate insights'}
              </button>
            </div>
          </div>
        )}
      </main>

      {/* ───── JOB DETAIL MODAL ───── */}
      {detailJobId && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-2 sm:p-6 animate-fade-in"
          onClick={closeDetail}>
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto shadow-2xl animate-slide-up"
            onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="sticky top-0 bg-white border-b border-surface-200 px-5 py-4 flex items-start justify-between gap-3 z-10">
              <div className="flex-1 min-w-0">
                <p className="text-base font-semibold text-ink-primary leading-tight">
                  {detail?.title || (detailLoading ? 'Loading…' : 'Job details')}
                </p>
                {detail && (
                  <p className="text-xs text-ink-tertiary mt-1 flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1"><Building2 size={11} />{detail.company}</span>
                    {detail.location && <span className="inline-flex items-center gap-1"><MapPin size={11} />{detail.location}</span>}
                    <span className="text-brand-600">{detail.source}</span>
                    {detail.postedAt && <span className="text-ink-muted">Posted {new Date(detail.postedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>}
                  </p>
                )}
              </div>
              <button onClick={closeDetail} className="p-1.5 text-ink-muted hover:text-ink-secondary hover:bg-surface-100 rounded-lg transition-colors shrink-0">
                <X size={18} />
              </button>
            </div>

            {/* Body */}
            <div className="p-5 space-y-5">
              {detailLoading && (
                <div className="text-center py-12 text-ink-tertiary text-sm">Loading job details…</div>
              )}

              {!detailLoading && detail && (
                <>
                  {/* Match score breakdown */}
                  <div className="bg-surface-50 border border-surface-200 rounded-xl p-4">
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div>
                        <p className="text-xs text-ink-tertiary">Match score</p>
                        <p className="text-3xl font-semibold" style={{
                          color: (detail.matchScore ?? 0) >= 80 ? '#10b981'
                               : (detail.matchScore ?? 0) >= 60 ? '#f59e0b'
                               : '#ef4444'
                        }}>
                          {detail.matchScore ?? '—'}<span className="text-base text-ink-tertiary">/100</span>
                        </p>
                      </div>
                      <StatusBadge status={detail.status} />
                    </div>
                    {detail.matchNotes && (
                      <p className="text-xs text-ink-secondary mb-3">{detail.matchNotes}</p>
                    )}
                    {detail.matchReasons && (
                      <div className="space-y-2">
                        {Object.entries(detail.matchReasons).map(([factor, r]) => {
                          const pct = r.max > 0 ? (r.points / r.max) * 100 : 0
                          const fillColor = pct >= 80 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444'
                          return (
                            <div key={factor}>
                              <div className="flex items-center justify-between text-xs mb-1">
                                <span className="text-ink-secondary capitalize">{factor}</span>
                                <span className="text-ink-tertiary">{r.points}/{r.max}</span>
                              </div>
                              <div className="w-full h-1.5 bg-surface-200 rounded-full overflow-hidden mb-1">
                                <div style={{ width: `${pct}%`, background: fillColor, height: '100%' }} />
                              </div>
                              <p className="text-xs text-ink-muted leading-snug">{r.detail}</p>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  {/* Description */}
                  <div>
                    <p className="text-xs font-semibold text-ink-primary mb-2">Job description</p>
                    {detail.description ? (
                      <div className="text-xs text-ink-secondary whitespace-pre-wrap leading-relaxed bg-white border border-surface-200 rounded-xl p-4 max-h-72 overflow-y-auto">
                        {detail.description}
                      </div>
                    ) : (
                      <p className="text-xs text-ink-muted italic">No description was scraped for this job.</p>
                    )}
                  </div>

                  {/* Apply history */}
                  {detail.applications && detail.applications.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-ink-primary mb-2">Apply history</p>
                      <div className="space-y-1.5">
                        {detail.applications.map(a => (
                          <div key={a.id} className="text-xs bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 flex items-center justify-between">
                            <span className="text-ink-secondary">
                              {new Date(a.submittedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                            </span>
                            <StatusBadge status={a.status} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-surface-200">
                    <a href={detail.sourceUrl} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 bg-brand-600 text-white rounded-xl hover:bg-brand-700 transition-colors">
                      <ExternalLink size={11} /> Open posting
                    </a>
                    {detail.status === 'FOUND' && (
                      <button onClick={() => { handleManualApply(detail.id); closeDetail() }}
                        className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 border border-surface-200 text-ink-secondary rounded-xl hover:bg-surface-100 transition-colors">
                        <Send size={11} /> Apply now
                      </button>
                    )}
                    {['FOUND', 'QUEUED', 'FAILED', 'SKIPPED'].includes(detail.status) && (
                      <button onClick={() => { handleMarkApplied(detail.id); closeDetail() }}
                        title="I applied to this job manually"
                        className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 border border-sky-200 text-sky-700 bg-sky-50 rounded-xl hover:bg-sky-100 transition-colors">
                        <CheckCircle2 size={11} /> Mark applied
                      </button>
                    )}
                    <button onClick={() => setFeedback(detail.id, 'UP')}
                      className={`flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-xl transition-colors ${
                        detail.feedback === 'UP'
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : 'border border-surface-200 text-ink-secondary hover:bg-emerald-50 hover:text-emerald-700'
                      }`}>
                      <ThumbsUp size={11} /> Good fit
                    </button>
                    <button onClick={() => setFeedback(detail.id, 'DOWN')}
                      className={`flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-xl transition-colors ${
                        detail.feedback === 'DOWN'
                          ? 'bg-red-50 text-red-700 border border-red-200'
                          : 'border border-surface-200 text-ink-secondary hover:bg-red-50 hover:text-red-700'
                      }`}>
                      <ThumbsDown size={11} /> Not a fit
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
