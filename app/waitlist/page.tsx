'use client'

import { useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'

/**
 * /waitlist — landing page for people whose email isn't on the allowlist.
 * Two paths here:
 *   1. Came from /signup or /signin with their email already known → form
 *      pre-filled, they just write a short reason and submit.
 *   2. Direct visitor → blank form.
 *
 * On submit we POST to /api/waitlist which upserts a WaitlistRequest row.
 * After that, show a confirmation message instead of redirecting (so they
 * know the request landed).
 */
function WaitlistForm() {
  const sp = useSearchParams()
  const [email, setEmail] = useState(sp?.get('email') || '')
  const [name, setName] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [errMsg, setErrMsg] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErrMsg(null)
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), name: name.trim(), reason: reason.trim() }),
      })
      const body = await res.json().catch(() => ({}))
      setBusy(false)
      if (!res.ok) {
        setErrMsg(body.error || 'Something went wrong.')
        return
      }
      setDone(true)
    } catch (err: any) {
      setErrMsg(err?.message || 'Network error.')
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <h1 className="font-display text-4xl text-ink-primary mb-2">JobPilot</h1>
          <p className="text-sm text-ink-tertiary">Automated job tracking for PM, APM &amp; BA roles</p>
        </div>

        <div className="bg-white rounded-2xl border border-surface-200 p-6 shadow-sm">
          {done ? (
            <div className="text-center py-6">
              <div className="w-12 h-12 rounded-full bg-emerald-100 border border-emerald-200 flex items-center justify-center mx-auto mb-3">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-600">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <h2 className="text-base font-semibold text-ink-primary mb-1">You&rsquo;re on the list</h2>
              <p className="text-xs text-ink-tertiary">
                We&rsquo;ll email you at <span className="text-ink-secondary font-medium">{email}</span> as soon as a spot opens up.
              </p>
              <Link
                href="/signin"
                className="inline-block mt-5 text-xs text-brand-600 hover:text-brand-700 font-medium"
              >
                ← Back to sign in
              </Link>
            </div>
          ) : (
            <>
              <h2 className="text-base font-semibold text-ink-primary mb-1">Request access</h2>
              <p className="text-xs text-ink-tertiary mb-4">
                JobPilot is in private beta. Drop your email and we&rsquo;ll let you know when a spot opens up.
              </p>

              {errMsg && (
                <div className="mb-4 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                  {errMsg}
                </div>
              )}

              <form onSubmit={handleSubmit} className="flex flex-col gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-ink-secondary font-medium">Email</span>
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    className="px-3 py-2 rounded-xl border border-surface-200 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100 transition-all"
                    placeholder="you@example.com"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-ink-secondary font-medium">Name (optional)</span>
                  <input
                    type="text"
                    autoComplete="name"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    className="px-3 py-2 rounded-xl border border-surface-200 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100 transition-all"
                    placeholder="Your name"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-ink-secondary font-medium">Why are you interested? (optional)</span>
                  <textarea
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    rows={3}
                    className="px-3 py-2 rounded-xl border border-surface-200 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100 transition-all resize-none"
                    placeholder="A line or two helps us prioritise."
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy}
                  className="mt-1 px-4 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
                >
                  {busy ? 'Submitting…' : 'Request access'}
                </button>
              </form>
            </>
          )}
        </div>

        {!done && (
          <p className="text-center text-xs text-ink-tertiary mt-6">
            Already on the list?{' '}
            <Link href="/signin" className="text-brand-600 hover:text-brand-700 font-medium">
              Sign in
            </Link>
          </p>
        )}
      </div>
    </div>
  )
}

export default function WaitlistPage() {
  return (
    <Suspense fallback={null}>
      <WaitlistForm />
    </Suspense>
  )
}
