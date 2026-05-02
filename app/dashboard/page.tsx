'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid, Legend, PieChart, Pie, Cell
} from 'recharts'
import {
  Search, RefreshCw, Settings, BrainCircuit, ChevronRight,
  Briefcase, Send, Clock, Trophy, AlertCircle, TrendingUp,
  Zap, Eye, RotateCcw, Filter, ChevronDown
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
}

const EMPTY_STATS: DashboardStats = {
  totalFound: 0, totalApplied: 0, inReview: 0, interviews: 0, failed: 0,
  successRate: 0,
  byRole: [], bySource: [], byStatus: [],
  recentActivity: [],
  lastScraperRun: null,
  scraperStatus: 'idle',
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
  appliedAt: string | null
  scrapedAt: string
  sourceUrl: string
  cvUsed: string | null
  applyMode: string
}

// ---- Components ----

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="bg-white rounded-2xl p-4 border border-surface-200 flex flex-col gap-1 animate-slide-up">
      <p className="text-xs text-ink-tertiary font-medium tracking-wide uppercase">{label}</p>
      <p className={`text-3xl font-semibold ${color || 'text-ink-primary'}`}>{value}</p>
      {sub && <p className="text-xs text-ink-tertiary">{sub}</p>}
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

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats>(EMPTY_STATS)
  const [jobs, setJobs] = useState<Job[]>([])
  const [autoApply, setAutoApply] = useState(true)
  const [activeTab, setActiveTab] = useState<'overview' | 'jobs' | 'analysis'>('overview')
  const [filterRole, setFilterRole] = useState('')
  const [filterSource, setFilterSource] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [search, setSearch] = useState('')
  const [scraperRunning, setScraperRunning] = useState(false)
  const [scraperMessage, setScraperMessage] = useState<string | null>(null)
  const [loadingData, setLoadingData] = useState(true)
  const [showInsights, setShowInsights] = useState(false)

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
      const params = new URLSearchParams({ limit: '100' })
      if (filterRole) params.set('roleType', filterRole)
      if (filterSource) params.set('source', filterSource.toLowerCase())
      if (filterStatus) params.set('status', filterStatus)
      const res = await fetch(`/api/jobs?${params}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setJobs(data.jobs || [])
    } catch (err) {
      console.error('Failed to load jobs', err)
    }
  }, [filterRole, filterSource, filterStatus])

  useEffect(() => {
    Promise.all([loadStats(), loadJobs()]).finally(() => setLoadingData(false))
    const interval = setInterval(() => {
      loadStats()
      if (activeTab === 'jobs') loadJobs()
    }, 30000)
    return () => clearInterval(interval)
  }, [loadStats, loadJobs, activeTab])

  useEffect(() => { loadJobs() }, [loadJobs])

  const filteredJobs = jobs.filter(j => {
    const matchRole = !filterRole || j.roleType === filterRole
    const matchSource = !filterSource || j.source.toLowerCase() === filterSource.toLowerCase()
    const matchStatus = !filterStatus || j.status === filterStatus
    const matchSearch = !search || j.title.toLowerCase().includes(search.toLowerCase()) || j.company.toLowerCase().includes(search.toLowerCase())
    return matchRole && matchSource && matchStatus && matchSearch
  })

  const manualPendingJobs = jobs.filter(j => j.status === 'FOUND' && !autoApply)

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

  async function handleSkip(jobId: string) {
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: 'SKIPPED' } : j))
    try {
      await patchJob(jobId, { status: 'SKIPPED' })
    } catch (err) {
      console.error(err)
      loadJobs()
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
    { id: 'overview', label: 'Overview' },
    { id: 'jobs', label: `Jobs (${filteredJobs.length})` },
    { id: 'analysis', label: 'CV Analysis' },
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

            <a href="/settings" className="p-2 rounded-xl hover:bg-surface-100 text-ink-tertiary transition-colors">
              <Settings size={16} />
            </a>
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
          <StatCard label="Failed" value={stats.failed} color="text-red-400" sub={stats.failed > 0 ? 'Need retry' : 'All clean'} />
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
          </div>
        )}

        {/* ===== JOBS TAB ===== */}
        {activeTab === 'jobs' && (
          <div className="animate-fade-in">
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
              <select value={filterSource} onChange={e => setFilterSource(e.target.value)}
                className="bg-white border border-surface-200 rounded-xl px-3 py-2 text-xs text-ink-secondary outline-none">
                <option value="">All sources</option>
                {stats.bySource.map(s => <option key={s.source} value={s.source}>{s.source}</option>)}
              </select>
              <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                className="bg-white border border-surface-200 rounded-xl px-3 py-2 text-xs text-ink-secondary outline-none">
                <option value="">All statuses</option>
                {Object.entries(STATUS_CONFIG).map(([v, c]) => <option key={v} value={v}>{c.label}</option>)}
              </select>
            </div>

            {/* Job cards */}
            <div className="space-y-2">
              {filteredJobs.map((job, i) => (
                <div key={job.id} className="job-card bg-white border border-surface-200 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center gap-3"
                  style={{ animationDelay: `${i * 30}ms` }}>
                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-ink-primary leading-tight">{job.title}</p>
                      {job.status === 'FOUND' && !autoApply && (
                        <span className="badge" style={{ background: '#fef3c7', color: '#d97706' }}>Needs approval</span>
                      )}
                    </div>
                    <p className="text-xs text-ink-tertiary mt-1">
                      {job.company} · {job.location} · <span className="text-brand-600">{job.source}</span>
                      {job.appliedAt && <> · Applied {new Date(job.appliedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</>}
                    </p>
                  </div>

                  {/* Right side */}
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-xs text-ink-muted bg-surface-100 px-2 py-1 rounded-lg">
                      {ROLE_LABELS[job.roleType]} CV
                    </span>
                    <MatchScore score={job.matchScore} />
                    <StatusBadge status={job.status} />

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

                    <a href={job.sourceUrl} target="_blank" rel="noopener noreferrer"
                      className="p-1.5 text-ink-muted hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors">
                      <ChevronRight size={14} />
                    </a>
                  </div>
                </div>
              ))}

              {filteredJobs.length === 0 && (
                <div className="text-center py-16 text-ink-tertiary">
                  <Briefcase size={32} className="mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No jobs match your filters</p>
                </div>
              )}
            </div>
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
                  <p className="text-xs text-ink-tertiary">AI scores your CV against a job description before applying</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-ink-tertiary block mb-1.5">Paste job description</label>
                  <textarea rows={5} placeholder="Paste the full JD here…"
                    className="w-full text-xs border border-surface-200 rounded-xl p-3 outline-none focus:border-brand-400 resize-none text-ink-secondary placeholder:text-ink-muted" />
                </div>
                <div>
                  <label className="text-xs text-ink-tertiary block mb-1.5">Select CV to score</label>
                  <select className="w-full text-xs border border-surface-200 rounded-xl px-3 py-2 outline-none mb-3 text-ink-secondary">
                    <option>APM CV</option>
                    <option>PM CV</option>
                    <option>Project Manager CV</option>
                    <option>Program Manager CV</option>
                    <option>Business Analyst CV</option>
                  </select>
                  <button className="w-full bg-brand-600 text-white text-xs font-medium py-2.5 rounded-xl hover:bg-brand-700 transition-colors flex items-center justify-center gap-2">
                    <BrainCircuit size={13} /> Analyse with AI
                  </button>
                  <p className="text-xs text-ink-muted mt-2 text-center">Uses Claude AI · ~5 sec</p>
                </div>
              </div>

              {/* Sample result */}
              <div className="mt-4 p-4 bg-emerald-50 border border-emerald-100 rounded-xl">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold text-emerald-800">Sample result — PM CV vs Razorpay APM JD</span>
                  <span className="text-2xl font-semibold text-emerald-600">88<span className="text-sm">/100</span></span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <p className="text-xs font-medium text-emerald-700 mb-1.5">Strengths</p>
                    {['Product metrics experience', 'Agile / Scrum background', 'B2B SaaS context'].map(s => (
                      <p key={s} className="text-xs text-emerald-600 flex gap-1.5 mb-1"><span>✓</span>{s}</p>
                    ))}
                  </div>
                  <div>
                    <p className="text-xs font-medium text-red-700 mb-1.5">Gaps</p>
                    {['No fintech domain mention', 'Missing OKR framework', 'Low SQL/data skill evidence'].map(s => (
                      <p key={s} className="text-xs text-red-500 flex gap-1.5 mb-1"><span>✗</span>{s}</p>
                    ))}
                  </div>
                  <div>
                    <p className="text-xs font-medium text-amber-700 mb-1.5">Add these keywords</p>
                    {['UPI', 'payment gateway', 'NPS', 'product discovery', 'A/B testing', 'GTM'].map(k => (
                      <span key={k} className="inline-block text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-lg mr-1 mb-1">{k}</span>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Post-application insights */}
            <div className="bg-white rounded-2xl border border-surface-200 p-5">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-7 h-7 rounded-lg bg-emerald-100 flex items-center justify-center">
                  <TrendingUp size={14} className="text-emerald-600" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-ink-primary">Post-application insights</h2>
                  <p className="text-xs text-ink-tertiary">What's working and what to change — based on your real outcomes</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="p-4 bg-emerald-50 border border-emerald-100 rounded-xl">
                  <p className="text-xs font-semibold text-emerald-800 mb-2">What's getting interviews</p>
                  {['PM roles at product startups', 'Roles mentioning "growth"', 'Bengaluru / Remote listings', 'Match score &gt;80'].map(s => (
                    <p key={s} className="text-xs text-emerald-600 mb-1">→ {s}</p>
                  ))}
                </div>
                <div className="p-4 bg-red-50 border border-red-100 rounded-xl">
                  <p className="text-xs font-semibold text-red-800 mb-2">What's not working</p>
                  {['MNC program manager roles', 'Roles needing PMP cert', 'Roles with 5yr+ experience', 'Job boards: IIMJobs'].map(s => (
                    <p key={s} className="text-xs text-red-500 mb-1">✗ {s}</p>
                  ))}
                </div>
                <div className="p-4 bg-brand-50 border border-brand-100 rounded-xl">
                  <p className="text-xs font-semibold text-brand-800 mb-2">CV improvements</p>
                  {['Add SQL project to BA CV', 'Quantify APM metrics more', 'Add fintech keywords to PM CV', 'Shorten PM CV to 1 page'].map(s => (
                    <p key={s} className="text-xs text-brand-600 mb-1">• {s}</p>
                  ))}
                </div>
              </div>
              <button className="mt-4 w-full sm:w-auto text-xs font-medium px-4 py-2 border border-surface-200 rounded-xl text-ink-secondary hover:bg-surface-100 transition-colors flex items-center gap-2">
                <BrainCircuit size={13} /> Regenerate insights from latest data
              </button>
            </div>

            {/* Interview conversion by role */}
            <div className="bg-white rounded-2xl border border-surface-200 p-5">
              <h2 className="text-sm font-semibold text-ink-primary mb-4">Interview conversion rate by role</h2>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={[
                  { role: 'APM', rate: 3.7 }, { role: 'PM', rate: 2.8 },
                  { role: 'Project Mgr', rate: 2.6 }, { role: 'Program Mgr', rate: 0 },
                  { role: 'BA', rate: 0 },
                ]}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f3f9" />
                  <XAxis dataKey="role" tick={{ fontSize: 11, fill: '#8b92a9' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => `${v}%`} tick={{ fontSize: 11, fill: '#8b92a9' }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: any) => [`${v}%`, 'Interview rate']} contentStyle={{ borderRadius: 10, border: '1px solid #e4e7f0', fontSize: 12 }} />
                  <Bar dataKey="rate" fill="#6366f1" radius={[6,6,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
