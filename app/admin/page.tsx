'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Check, X, Trash2, UserPlus, ArrowLeft } from 'lucide-react'

/**
 * Admin console: manage the email allowlist and review waitlist requests.
 *
 * Access: ADMIN role only. Non-admins get bounced to /dashboard.
 *
 * Two tabs:
 *  - Waitlist: PENDING requests with Approve / Decline actions (approve
 *    auto-adds to allowlist).
 *  - Allowlist: current allowed emails with quick-add and remove.
 */

interface WaitlistRow {
  id:        string
  email:     string
  name?:     string | null
  reason?:   string | null
  status:    'PENDING' | 'APPROVED' | 'DECLINED'
  createdAt: string
}

interface AllowlistRow {
  id:        string
  email:     string
  note?:     string | null
  createdAt: string
}

export default function AdminPage() {
  const { data: session, status } = useSession()
  const router = useRouter()

  const role = (session?.user as any)?.role
  const isAdmin = role === 'ADMIN'

  const [tab, setTab] = useState<'waitlist' | 'allowlist'>('waitlist')
  const [statusFilter, setStatusFilter] = useState<'PENDING' | 'APPROVED' | 'DECLINED'>('PENDING')
  const [waitlist, setWaitlist] = useState<WaitlistRow[]>([])
  const [allowlist, setAllowlist] = useState<AllowlistRow[]>([])
  const [newEmail, setNewEmail] = useState('')
  const [newNote, setNewNote] = useState('')
  const [busy, setBusy] = useState(false)

  // Redirect non-admins. Wait for session to load before bouncing — the
  // brief unauthenticated state during hydration would otherwise misfire.
  useEffect(() => {
    if (status === 'loading') return
    if (!session || !isAdmin) router.replace('/dashboard')
  }, [status, session, isAdmin, router])

  const loadWaitlist = useCallback(async () => {
    const res = await fetch(`/api/admin/waitlist?status=${statusFilter}`, { cache: 'no-store' })
    if (!res.ok) return
    const data = await res.json()
    setWaitlist(data.rows || [])
  }, [statusFilter])

  const loadAllowlist = useCallback(async () => {
    const res = await fetch('/api/admin/allowlist', { cache: 'no-store' })
    if (!res.ok) return
    const data = await res.json()
    setAllowlist(data.rows || [])
  }, [])

  useEffect(() => {
    if (!isAdmin) return
    if (tab === 'waitlist') loadWaitlist()
    else loadAllowlist()
  }, [tab, isAdmin, loadWaitlist, loadAllowlist])

  async function handleAction(email: string, action: 'approve' | 'decline') {
    setBusy(true)
    await fetch('/api/admin/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, action }),
    })
    await loadWaitlist()
    setBusy(false)
  }

  async function handleAddAllowlist(e: React.FormEvent) {
    e.preventDefault()
    if (!newEmail.trim()) return
    setBusy(true)
    await fetch('/api/admin/allowlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: newEmail.trim().toLowerCase(), note: newNote.trim() || null }),
    })
    setNewEmail('')
    setNewNote('')
    await loadAllowlist()
    setBusy(false)
  }

  async function handleRemoveAllowlist(email: string) {
    if (!confirm(`Remove ${email} from allowlist?`)) return
    setBusy(true)
    await fetch(`/api/admin/allowlist?email=${encodeURIComponent(email)}`, { method: 'DELETE' })
    await loadAllowlist()
    setBusy(false)
  }

  if (status === 'loading' || !isAdmin) {
    return <div className="min-h-screen bg-surface-50" />
  }

  return (
    <div className="min-h-screen bg-surface-50">
      {/* Header */}
      <header className="bg-white border-b border-surface-200 sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="p-2 -ml-2 rounded-xl hover:bg-surface-100 text-ink-tertiary">
              <ArrowLeft size={16} />
            </Link>
            <span className="font-display text-lg text-ink-primary">Admin</span>
          </div>
          <span className="text-xs text-ink-tertiary">{session?.user?.email}</span>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        {/* Tabs */}
        <div className="flex gap-1 mb-5 bg-surface-100 rounded-xl p-1 border border-surface-200 max-w-sm">
          <button
            onClick={() => setTab('waitlist')}
            className={`flex-1 text-xs font-medium py-2 px-3 rounded-lg transition-all ${
              tab === 'waitlist'
                ? 'bg-white text-brand-600 shadow-sm border border-surface-200'
                : 'text-ink-tertiary hover:text-ink-secondary'
            }`}
          >
            Waitlist
          </button>
          <button
            onClick={() => setTab('allowlist')}
            className={`flex-1 text-xs font-medium py-2 px-3 rounded-lg transition-all ${
              tab === 'allowlist'
                ? 'bg-white text-brand-600 shadow-sm border border-surface-200'
                : 'text-ink-tertiary hover:text-ink-secondary'
            }`}
          >
            Allowlist
          </button>
        </div>

        {tab === 'waitlist' ? (
          <>
            <div className="flex items-center justify-between mb-3">
              <h1 className="text-sm font-semibold text-ink-primary">Waitlist requests</h1>
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value as any)}
                className="bg-white border border-surface-200 rounded-xl px-3 py-1.5 text-xs text-ink-secondary outline-none"
              >
                <option value="PENDING">Pending</option>
                <option value="APPROVED">Approved</option>
                <option value="DECLINED">Declined</option>
              </select>
            </div>

            {waitlist.length === 0 ? (
              <div className="bg-white rounded-2xl border border-surface-200 p-8 text-center text-xs text-ink-tertiary">
                No {statusFilter.toLowerCase()} requests.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {waitlist.map(row => (
                  <div key={row.id} className="bg-white rounded-2xl border border-surface-200 p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-ink-primary truncate">{row.email}</p>
                      {row.name && <p className="text-xs text-ink-secondary truncate">{row.name}</p>}
                      {row.reason && <p className="text-xs text-ink-tertiary mt-1 line-clamp-2">{row.reason}</p>}
                      <p className="text-[10px] text-ink-muted mt-1">
                        {new Date(row.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                    {row.status === 'PENDING' && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleAction(row.email, 'approve')}
                          disabled={busy}
                          className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium disabled:opacity-50"
                        >
                          <Check size={12} /> Approve
                        </button>
                        <button
                          onClick={() => handleAction(row.email, 'decline')}
                          disabled={busy}
                          className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-surface-100 hover:bg-surface-200 text-ink-secondary text-xs font-medium disabled:opacity-50"
                        >
                          <X size={12} /> Decline
                        </button>
                      </div>
                    )}
                    {row.status !== 'PENDING' && (
                      <span className={`text-[10px] uppercase tracking-wider font-semibold ${
                        row.status === 'APPROVED' ? 'text-emerald-600' : 'text-ink-tertiary'
                      }`}>
                        {row.status}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <h1 className="text-sm font-semibold text-ink-primary mb-3">Email allowlist</h1>

            <form onSubmit={handleAddAllowlist} className="bg-white rounded-2xl border border-surface-200 p-4 mb-4 flex flex-col sm:flex-row gap-2">
              <input
                type="email"
                required
                value={newEmail}
                onChange={e => setNewEmail(e.target.value)}
                placeholder="email@example.com"
                className="flex-1 px-3 py-2 rounded-xl border border-surface-200 text-sm outline-none focus:border-brand-400"
              />
              <input
                type="text"
                value={newNote}
                onChange={e => setNewNote(e.target.value)}
                placeholder="note (optional)"
                className="flex-1 px-3 py-2 rounded-xl border border-surface-200 text-sm outline-none focus:border-brand-400"
              />
              <button
                type="submit"
                disabled={busy || !newEmail.trim()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-xs font-medium"
              >
                <UserPlus size={12} /> Add
              </button>
            </form>

            {allowlist.length === 0 ? (
              <div className="bg-white rounded-2xl border border-surface-200 p-8 text-center text-xs text-ink-tertiary">
                Allowlist is empty.
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-surface-200 divide-y divide-surface-200">
                {allowlist.map(row => (
                  <div key={row.id} className="p-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-ink-primary truncate">{row.email}</p>
                      {row.note && <p className="text-[11px] text-ink-tertiary truncate">{row.note}</p>}
                    </div>
                    <span className="text-[10px] text-ink-muted hidden sm:block">
                      {new Date(row.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                    </span>
                    <button
                      onClick={() => handleRemoveAllowlist(row.email)}
                      disabled={busy}
                      className="p-1.5 rounded-lg hover:bg-red-50 text-red-500 disabled:opacity-50"
                      title="Remove"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
