'use client'

import { useState, useEffect } from 'react'
import { Shield, Upload, Eye, EyeOff, CheckCircle, Plus, Trash2, ArrowLeft, User, X, RefreshCw } from 'lucide-react'
import Link from 'next/link'

const SITES = [
  { name: 'Naukri', url: 'naukri.com', color: '#0066cc' },
  { name: 'LinkedIn', url: 'linkedin.com', color: '#0a66c2' },
  { name: 'IIMJobs', url: 'iimjobs.com', color: '#e84b37' },
  { name: 'Instahyre', url: 'instahyre.com', color: '#00a3e0' },
  { name: 'Hirist', url: 'hirist.tech', color: '#6366f1' },
  { name: 'Wellfound', url: 'wellfound.com', color: '#000000' },
]

const ROLE_TYPES = [
  { value: 'APM', label: 'Associate Product Manager (APM)' },
  { value: 'PM', label: 'Product Manager (PM)' },
  { value: 'PROJECT_MANAGER', label: 'Project Manager' },
  { value: 'PROGRAM_MANAGER', label: 'Program Manager' },
  { value: 'BUSINESS_ANALYST', label: 'Business Analyst (BA)' },
]

interface CredState { username: string; password: string; saved: boolean; showPwd: boolean; saving?: boolean; error?: string }

interface ProfileState {
  fullName: string
  email: string
  phone: string
  yearsExperience: string
  currentRole: string
  expectedSalaryLpa: string
  noticePeriodDays: string
  skills: string[]
  preferredLocations: string[]
  preferredIndustries: string[]
  remoteOnly: boolean
  minMatchScore: number
}

const EMPTY_PROFILE: ProfileState = {
  fullName: '',
  email: '',
  phone: '',
  yearsExperience: '',
  currentRole: '',
  expectedSalaryLpa: '',
  noticePeriodDays: '',
  skills: [],
  preferredLocations: ['bengaluru', 'remote'],
  preferredIndustries: [],
  remoteOnly: false,
  minMatchScore: 60,
}

export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState<'profile' | 'credentials' | 'cvs' | 'mnc' | 'preferences'>('profile')

  const [creds, setCreds] = useState<Record<string, CredState>>(() =>
    Object.fromEntries(SITES.map(s => [s.name, { username: '', password: '', saved: false, showPwd: false }]))
  )

  const [cvFiles, setCvFiles] = useState<Record<string, { name: string; size: string } | null>>(
    Object.fromEntries(ROLE_TYPES.map(r => [r.value, null]))
  )
  const [isUploading, setIsUploading] = useState<Record<string, boolean>>({})

  // Profile state — drives the match-scoring engine on the server
  const [profile, setProfile] = useState<ProfileState>(EMPTY_PROFILE)
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMessage, setProfileMessage] = useState<string | null>(null)
  const [skillInput, setSkillInput] = useState('')
  const [locationInput, setLocationInput] = useState('')
  const [industryInput, setIndustryInput] = useState('')

  useEffect(() => {
    fetch('/api/resumes')
      .then(res => res.json())
      .then(data => {
        if (data.cvs) {
          const loadedCvs: Record<string, { name: string; size: string }> = {}
          data.cvs.forEach((cv: any) => {
            loadedCvs[cv.roleType] = { name: cv.fileName, size: 'Stored in DB' }
          })
          setCvFiles(prev => ({ ...prev, ...loadedCvs }))
        }
      })
      .catch(err => console.error('Failed to load CVs', err))

    // Load saved-credential state so the badge reflects DB truth.
    fetch('/api/credentials')
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) {
          setCreds(prev => {
            const next = { ...prev }
            for (const c of data) {
              if (next[c.siteName]) {
                next[c.siteName] = {
                  ...next[c.siteName],
                  username: c.username || next[c.siteName].username,
                  saved: true,
                }
              }
            }
            return next
          })
        }
      })
      .catch(err => console.error('Failed to load credentials', err))

    // Load saved profile so the form reflects DB truth.
    fetch('/api/profile')
      .then(res => res.json())
      .then(data => {
        if (data?.id) {
          setProfile({
            fullName:            data.fullName ?? '',
            email:               data.email ?? '',
            phone:               data.phone ?? '',
            yearsExperience:     data.yearsExperience != null ? String(data.yearsExperience) : '',
            currentRole:         data.currentRole ?? '',
            expectedSalaryLpa:   data.expectedSalaryLpa != null ? String(data.expectedSalaryLpa) : '',
            noticePeriodDays:    data.noticePeriodDays != null ? String(data.noticePeriodDays) : '',
            skills:              Array.isArray(data.skills) ? data.skills : [],
            preferredLocations:  Array.isArray(data.preferredLocations) ? data.preferredLocations : [],
            preferredIndustries: Array.isArray(data.preferredIndustries) ? data.preferredIndustries : [],
            remoteOnly:          !!data.remoteOnly,
            minMatchScore:       typeof data.minMatchScore === 'number' ? data.minMatchScore : 60,
          })
        }
      })
      .catch(err => console.error('Failed to load profile', err))
  }, [])

  function addToList(field: 'skills' | 'preferredLocations' | 'preferredIndustries', value: string, clear: () => void) {
    const v = value.trim().toLowerCase()
    if (!v) return
    setProfile(prev => prev[field].includes(v) ? prev : { ...prev, [field]: [...prev[field], v] })
    clear()
  }

  function removeFromList(field: 'skills' | 'preferredLocations' | 'preferredIndustries', value: string) {
    setProfile(prev => ({ ...prev, [field]: prev[field].filter(v => v !== value) }))
  }

  async function saveProfile(rescore: boolean) {
    setProfileSaving(true)
    setProfileMessage(null)
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName:            profile.fullName || null,
          email:               profile.email || null,
          phone:               profile.phone || null,
          yearsExperience:     profile.yearsExperience === '' ? null : Number(profile.yearsExperience),
          currentRole:         profile.currentRole || null,
          expectedSalaryLpa:   profile.expectedSalaryLpa === '' ? null : Number(profile.expectedSalaryLpa),
          noticePeriodDays:    profile.noticePeriodDays === '' ? null : Number(profile.noticePeriodDays),
          skills:              profile.skills,
          preferredLocations:  profile.preferredLocations,
          preferredIndustries: profile.preferredIndustries,
          remoteOnly:          profile.remoteOnly,
          minMatchScore:       profile.minMatchScore,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `Save failed (${res.status})`)
      }
      setProfileMessage('Profile saved')
      if (rescore) {
        const r = await fetch('/api/jobs/rescore', { method: 'POST' })
        const data = await r.json().catch(() => ({}))
        setProfileMessage(r.ok ? `Profile saved · ${data.rescored ?? 0} jobs re-scored` : 'Saved, but rescoring failed')
      }
    } catch (err: any) {
      setProfileMessage(err?.message || 'Save failed')
    } finally {
      setProfileSaving(false)
      setTimeout(() => setProfileMessage(null), 6000)
    }
  }

  function updateCred(site: string, field: string, val: any) {
    setCreds(prev => ({ ...prev, [site]: { ...prev[site], [field]: val, saved: false, error: undefined } }))
  }

  async function saveCred(site: string) {
    const c = creds[site]
    const siteMeta = SITES.find(s => s.name === site)
    if (!c || !siteMeta) return
    setCreds(prev => ({ ...prev, [site]: { ...prev[site], saving: true, error: undefined } }))
    try {
      const res = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteName: site,
          siteUrl: siteMeta.url,
          username: c.username,
          password: c.password,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`)
      setCreds(prev => ({ ...prev, [site]: { ...prev[site], saved: true, saving: false, password: '' } }))
    } catch (err: any) {
      setCreds(prev => ({ ...prev, [site]: { ...prev[site], saving: false, error: err?.message || 'Save failed' } }))
    }
  }

  async function handleCvUpload(role: string, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setIsUploading(prev => ({ ...prev, [role]: true }))
    
    const formData = new FormData()
    formData.append('file', file)
    formData.append('roleType', role)

    try {
      const res = await fetch('/api/resumes', {
        method: 'POST',
        body: formData,
      })
      
      const data = await res.json()
      if (res.ok && data.success) {
        const kb = (file.size / 1024).toFixed(0)
        setCvFiles(prev => ({ ...prev, [role]: { name: file.name, size: `${kb} KB` } }))
      } else {
        alert(data.error || 'Failed to upload CV')
      }
    } catch (err) {
      console.error(err)
      alert('Network error during upload')
    } finally {
      setIsUploading(prev => ({ ...prev, [role]: false }))
    }
  }

  const sections = [
    { id: 'profile', label: 'Profile' },
    { id: 'credentials', label: 'Site credentials' },
    { id: 'cvs', label: 'CV files' },
    { id: 'mnc', label: 'MNC targets' },
    { id: 'preferences', label: 'Preferences' },
  ]

  return (
    <div className="min-h-screen bg-surface-50">
      <header className="bg-white border-b border-surface-200 sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link href="/dashboard" className="p-2 rounded-xl hover:bg-surface-100 text-ink-tertiary transition-colors">
            <ArrowLeft size={16} />
          </Link>
          <span className="text-sm font-semibold text-ink-primary">Settings</span>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        <div className="flex gap-2 mb-6 overflow-x-auto pb-1">
          {sections.map(s => (
            <button key={s.id} onClick={() => setActiveSection(s.id as any)}
              className={`text-xs font-medium px-4 py-2 rounded-xl whitespace-nowrap transition-all ${
                activeSection === s.id ? 'bg-brand-600 text-white' : 'bg-white border border-surface-200 text-ink-secondary hover:bg-surface-100'
              }`}>
              {s.label}
            </button>
          ))}
        </div>

        {/* ── PROFILE ── */}
        {activeSection === 'profile' && (
          <div className="space-y-4 animate-fade-in">
            <div className="flex items-center gap-2 mb-2">
              <User size={15} className="text-brand-600" />
              <p className="text-xs text-ink-tertiary">
                These details drive the match-score engine. The more accurate your profile, the better jobs are ranked.
              </p>
            </div>

            {/* Basic info */}
            <div className="bg-white border border-surface-200 rounded-2xl p-5">
              <p className="text-sm font-semibold text-ink-primary mb-4">Basic info</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-ink-tertiary block mb-1">Full name</label>
                  <input value={profile.fullName} onChange={e => setProfile(p => ({ ...p, fullName: e.target.value }))}
                    placeholder="Your name"
                    className="w-full text-xs border border-surface-200 rounded-xl px-3 py-2 outline-none focus:border-brand-400 text-ink-primary placeholder:text-ink-muted" />
                </div>
                <div>
                  <label className="text-xs text-ink-tertiary block mb-1">Email</label>
                  <input type="email" value={profile.email} onChange={e => setProfile(p => ({ ...p, email: e.target.value }))}
                    placeholder="you@email.com"
                    className="w-full text-xs border border-surface-200 rounded-xl px-3 py-2 outline-none focus:border-brand-400 text-ink-primary placeholder:text-ink-muted" />
                </div>
                <div>
                  <label className="text-xs text-ink-tertiary block mb-1">Phone</label>
                  <input value={profile.phone} onChange={e => setProfile(p => ({ ...p, phone: e.target.value }))}
                    placeholder="+91 xxxxx xxxxx"
                    className="w-full text-xs border border-surface-200 rounded-xl px-3 py-2 outline-none focus:border-brand-400 text-ink-primary placeholder:text-ink-muted" />
                </div>
                <div>
                  <label className="text-xs text-ink-tertiary block mb-1">Current role</label>
                  <input value={profile.currentRole} onChange={e => setProfile(p => ({ ...p, currentRole: e.target.value }))}
                    placeholder="e.g. APM at Razorpay"
                    className="w-full text-xs border border-surface-200 rounded-xl px-3 py-2 outline-none focus:border-brand-400 text-ink-primary placeholder:text-ink-muted" />
                </div>
                <div>
                  <label className="text-xs text-ink-tertiary block mb-1">Years of experience</label>
                  <input type="number" min={0} max={50} value={profile.yearsExperience}
                    onChange={e => setProfile(p => ({ ...p, yearsExperience: e.target.value }))}
                    placeholder="0"
                    className="w-full text-xs border border-surface-200 rounded-xl px-3 py-2 outline-none focus:border-brand-400 text-ink-primary placeholder:text-ink-muted" />
                </div>
                <div>
                  <label className="text-xs text-ink-tertiary block mb-1">Expected salary (LPA)</label>
                  <input type="number" min={0} max={100} value={profile.expectedSalaryLpa}
                    onChange={e => setProfile(p => ({ ...p, expectedSalaryLpa: e.target.value }))}
                    placeholder="e.g. 18"
                    className="w-full text-xs border border-surface-200 rounded-xl px-3 py-2 outline-none focus:border-brand-400 text-ink-primary placeholder:text-ink-muted" />
                </div>
                <div>
                  <label className="text-xs text-ink-tertiary block mb-1">Notice period (days)</label>
                  <input type="number" min={0} max={365} value={profile.noticePeriodDays}
                    onChange={e => setProfile(p => ({ ...p, noticePeriodDays: e.target.value }))}
                    placeholder="e.g. 60"
                    className="w-full text-xs border border-surface-200 rounded-xl px-3 py-2 outline-none focus:border-brand-400 text-ink-primary placeholder:text-ink-muted" />
                </div>
              </div>
            </div>

            {/* Skills */}
            <div className="bg-white border border-surface-200 rounded-2xl p-5">
              <p className="text-sm font-semibold text-ink-primary mb-1">Skills</p>
              <p className="text-xs text-ink-tertiary mb-3">Each skill is matched against job descriptions for scoring. Add 5-15 for best results.</p>
              <div className="flex gap-2 mb-3">
                <input value={skillInput} onChange={e => setSkillInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addToList('skills', skillInput, () => setSkillInput('')) } }}
                  placeholder="e.g. sql, product analytics, figma"
                  className="flex-1 text-xs border border-surface-200 rounded-xl px-3 py-2 outline-none focus:border-brand-400 text-ink-primary placeholder:text-ink-muted" />
                <button type="button" onClick={() => addToList('skills', skillInput, () => setSkillInput(''))}
                  className="text-xs font-medium px-4 py-2 bg-brand-600 text-white rounded-xl hover:bg-brand-700 transition-colors">
                  Add
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {profile.skills.length === 0 && <span className="text-xs text-ink-muted">No skills yet — add some above.</span>}
                {profile.skills.map(s => (
                  <span key={s} className="inline-flex items-center gap-1 text-xs bg-brand-50 text-brand-700 px-2 py-1 rounded-lg">
                    {s}
                    <button onClick={() => removeFromList('skills', s)} className="text-brand-500 hover:text-red-500">
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            </div>

            {/* Preferred locations */}
            <div className="bg-white border border-surface-200 rounded-2xl p-5">
              <p className="text-sm font-semibold text-ink-primary mb-1">Preferred locations</p>
              <p className="text-xs text-ink-tertiary mb-3">Cities you'd accept jobs in. "remote" matches any remote role.</p>
              <div className="flex gap-2 mb-3">
                <input value={locationInput} onChange={e => setLocationInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addToList('preferredLocations', locationInput, () => setLocationInput('')) } }}
                  placeholder="e.g. bengaluru, mumbai, remote"
                  className="flex-1 text-xs border border-surface-200 rounded-xl px-3 py-2 outline-none focus:border-brand-400 text-ink-primary placeholder:text-ink-muted" />
                <button type="button" onClick={() => addToList('preferredLocations', locationInput, () => setLocationInput(''))}
                  className="text-xs font-medium px-4 py-2 bg-brand-600 text-white rounded-xl hover:bg-brand-700 transition-colors">
                  Add
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {profile.preferredLocations.length === 0 && <span className="text-xs text-ink-muted">No locations yet.</span>}
                {profile.preferredLocations.map(l => (
                  <span key={l} className="inline-flex items-center gap-1 text-xs bg-emerald-50 text-emerald-700 px-2 py-1 rounded-lg">
                    {l}
                    <button onClick={() => removeFromList('preferredLocations', l)} className="text-emerald-500 hover:text-red-500">
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
              <label className="flex items-center gap-2 text-xs text-ink-secondary">
                <input type="checkbox" checked={profile.remoteOnly}
                  onChange={e => setProfile(p => ({ ...p, remoteOnly: e.target.checked }))}
                  className="rounded" />
                Remote-only — penalise India-only on-site jobs
              </label>
            </div>

            {/* Industries */}
            <div className="bg-white border border-surface-200 rounded-2xl p-5">
              <p className="text-sm font-semibold text-ink-primary mb-1">Preferred industries</p>
              <p className="text-xs text-ink-tertiary mb-3">Substring-matched against company name and description.</p>
              <div className="flex gap-2 mb-3">
                <input value={industryInput} onChange={e => setIndustryInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addToList('preferredIndustries', industryInput, () => setIndustryInput('')) } }}
                  placeholder="e.g. fintech, ecommerce, saas, healthcare"
                  className="flex-1 text-xs border border-surface-200 rounded-xl px-3 py-2 outline-none focus:border-brand-400 text-ink-primary placeholder:text-ink-muted" />
                <button type="button" onClick={() => addToList('preferredIndustries', industryInput, () => setIndustryInput(''))}
                  className="text-xs font-medium px-4 py-2 bg-brand-600 text-white rounded-xl hover:bg-brand-700 transition-colors">
                  Add
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {profile.preferredIndustries.length === 0 && <span className="text-xs text-ink-muted">No industries yet.</span>}
                {profile.preferredIndustries.map(i => (
                  <span key={i} className="inline-flex items-center gap-1 text-xs bg-amber-50 text-amber-700 px-2 py-1 rounded-lg">
                    {i}
                    <button onClick={() => removeFromList('preferredIndustries', i)} className="text-amber-500 hover:text-red-500">
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            </div>

            {/* Auto-apply threshold */}
            <div className="bg-white border border-surface-200 rounded-2xl p-5">
              <p className="text-sm font-semibold text-ink-primary mb-1">Minimum match score for auto-apply</p>
              <p className="text-xs text-ink-tertiary mb-3">
                In Auto Apply mode, only jobs scoring at or above this threshold get queued. Lower-scored jobs land in
                "Found" for you to review manually.
              </p>
              <div className="flex items-center gap-3">
                <input type="range" min={0} max={100} value={profile.minMatchScore}
                  onChange={e => setProfile(p => ({ ...p, minMatchScore: Number(e.target.value) }))}
                  className="flex-1" />
                <span className="text-sm font-semibold text-brand-600 w-10 text-right">{profile.minMatchScore}</span>
              </div>
            </div>

            {/* Save */}
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button onClick={() => saveProfile(false)} disabled={profileSaving}
                className="text-xs font-medium px-4 py-2 bg-brand-600 text-white rounded-xl hover:bg-brand-700 transition-colors disabled:opacity-40">
                {profileSaving ? 'Saving…' : 'Save profile'}
              </button>
              <button onClick={() => saveProfile(true)} disabled={profileSaving}
                className="flex items-center gap-1.5 text-xs font-medium px-4 py-2 border border-surface-200 text-ink-secondary rounded-xl hover:bg-surface-100 transition-colors disabled:opacity-40">
                <RefreshCw size={11} /> Save & re-score all jobs
              </button>
              {profileMessage && <span className="text-xs text-ink-tertiary">{profileMessage}</span>}
            </div>
          </div>
        )}

        {/* ── CREDENTIALS ── */}
        {activeSection === 'credentials' && (
          <div className="space-y-4 animate-fade-in">
            <div className="flex items-center gap-2 mb-2">
              <Shield size={15} className="text-brand-600" />
              <p className="text-xs text-ink-tertiary">Credentials are AES-256 encrypted before storage. Never shared externally.</p>
            </div>
            {SITES.map(site => {
              const c = creds[site.name]
              return (
                <div key={site.name} className="bg-white border border-surface-200 rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-2 h-2 rounded-full" style={{ background: site.color }} />
                    <span className="text-sm font-semibold text-ink-primary">{site.name}</span>
                    <span className="text-xs text-ink-muted">{site.url}</span>
                    {c.saved && <span className="ml-auto badge" style={{ background: '#d1fae5', color: '#059669' }}><CheckCircle size={10} /> Saved</span>}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-ink-tertiary block mb-1">Email / Username</label>
                      <input
                        type="email"
                        value={c.username}
                        onChange={e => updateCred(site.name, 'username', e.target.value)}
                        placeholder="yourname@email.com"
                        className="w-full text-xs border border-surface-200 rounded-xl px-3 py-2 outline-none focus:border-brand-400 text-ink-primary placeholder:text-ink-muted"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-ink-tertiary block mb-1">Password</label>
                      <div className="relative">
                        <input
                          type={c.showPwd ? 'text' : 'password'}
                          value={c.password}
                          onChange={e => updateCred(site.name, 'password', e.target.value)}
                          placeholder="••••••••"
                          className="w-full text-xs border border-surface-200 rounded-xl px-3 py-2 pr-9 outline-none focus:border-brand-400 text-ink-primary placeholder:text-ink-muted"
                        />
                        <button type="button" onClick={() => updateCred(site.name, 'showPwd', !c.showPwd)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink-secondary">
                          {c.showPwd ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-3">
                    <button onClick={() => saveCred(site.name)}
                      disabled={!c.username || !c.password || c.saving}
                      className="text-xs font-medium px-4 py-2 bg-brand-600 text-white rounded-xl hover:bg-brand-700 transition-colors disabled:opacity-40">
                      {c.saving ? 'Saving…' : 'Save encrypted'}
                    </button>
                    {c.error && <span className="text-xs text-red-600">{c.error}</span>}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* ── CV FILES ── */}
        {activeSection === 'cvs' && (
          <div className="space-y-4 animate-fade-in">
            <p className="text-xs text-ink-tertiary mb-2">Upload one PDF per role. The correct CV is auto-selected based on the job type.</p>
            {ROLE_TYPES.map(role => (
              <div key={role.value} className="bg-white border border-surface-200 rounded-2xl p-5 flex items-center gap-4">
                <div className="flex-1">
                  <p className="text-sm font-semibold text-ink-primary">{role.label}</p>
                  {cvFiles[role.value]
                    ? <p className="text-xs text-emerald-600 mt-1">✓ {cvFiles[role.value]!.name} · {cvFiles[role.value]!.size}</p>
                    : <p className="text-xs text-ink-muted mt-1">No CV uploaded yet</p>
                  }
                </div>
                <label className={`flex items-center gap-1.5 text-xs font-medium px-3 py-2 border border-surface-200 rounded-xl transition-colors ${isUploading[role.value] ? 'text-ink-muted bg-surface-50 cursor-not-allowed' : 'text-ink-secondary hover:bg-surface-100 cursor-pointer'}`}>
                  <Upload size={12} />
                  {isUploading[role.value] ? 'Uploading...' : (cvFiles[role.value] ? 'Replace' : 'Upload PDF')}
                  <input type="file" accept=".pdf" className="hidden" disabled={isUploading[role.value]} onChange={e => handleCvUpload(role.value, e)} />
                </label>
              </div>
            ))}
          </div>
        )}

        {/* ── MNC TARGETS ── */}
        {activeSection === 'mnc' && (
          <div className="animate-fade-in">
            <p className="text-xs text-ink-tertiary mb-4">These company career sites are scraped for matching roles.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {['TCS', 'Cognizant', 'Sprinklr', 'Accenture', 'LTIMindtree', 'Wipro', 'Deloitte', 'KPMG', 'EY', 'PhonePe', 'Razorpay', 'Juspay', 'Flipkart', 'Uber', 'Paytm', 'Genpact', 'HCLTech', 'MakeMyTrip', 'Goibibo', 'Amazon'].map(co => (
                <div key={co} className="bg-white border border-surface-200 rounded-xl px-4 py-3 flex items-center gap-3">
                  <div className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center text-xs font-bold text-brand-600">
                    {co.slice(0, 2).toUpperCase()}
                  </div>
                  <span className="text-sm text-ink-primary flex-1">{co}</span>
                  <CheckCircle size={14} className="text-emerald-500" />
                </div>
              ))}
            </div>
            <button className="mt-4 flex items-center gap-2 text-xs font-medium px-4 py-2 border border-dashed border-surface-300 rounded-xl text-ink-tertiary hover:border-brand-400 hover:text-brand-600 transition-colors">
              <Plus size={13} /> Add company
            </button>
          </div>
        )}

        {/* ── PREFERENCES ── */}
        {activeSection === 'preferences' && (
          <div className="space-y-4 animate-fade-in">
            {[
              { label: 'Default apply mode', desc: 'Auto applies to all matching jobs without review', key: 'autoApply' },
              { label: 'Email notifications', desc: 'Get notified on interview calls and failures', key: 'email' },
              { label: 'Skip duplicate companies', desc: 'Don\'t apply to same company twice in 30 days', key: 'dedupCo' },
              { label: 'Minimum match score', desc: 'Only apply to jobs scoring above threshold', key: 'minScore' },
            ].map(p => (
              <div key={p.key} className="bg-white border border-surface-200 rounded-2xl p-4 flex items-center gap-4">
                <div className="flex-1">
                  <p className="text-sm font-semibold text-ink-primary">{p.label}</p>
                  <p className="text-xs text-ink-tertiary mt-0.5">{p.desc}</p>
                </div>
                {p.key === 'minScore' ? (
                  <div className="flex items-center gap-2">
                    <input type="range" min={0} max={100} defaultValue={60} className="w-24" />
                    <span className="text-xs font-medium text-ink-secondary w-8 text-right">60</span>
                  </div>
                ) : (
                  <label className="toggle-switch">
                    <input type="checkbox" defaultChecked={p.key !== 'email'} />
                    <span className="toggle-slider" />
                  </label>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
