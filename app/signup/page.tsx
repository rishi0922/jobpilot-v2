'use client'

import { useState, Suspense } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'

/**
 * Sign-up page. Posts to /api/auth/signup which enforces the email
 * allowlist. On a 403 (email not allowlisted) we redirect to /waitlist
 * with the email pre-filled. On success we auto-sign-in via the
 * Credentials provider and route to /dashboard.
 *
 * Google signup goes through the standard NextAuth Google flow — the
 * signIn callback in lib/auth.ts will reject non-allowlisted emails the
 * same way and we handle that on the /signin page (AccessDenied error).
 */
function SignUpForm() {
  const router = useRouter()
  const sp = useSearchParams()

  const [email, setEmail] = useState(sp?.get('email') || '')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [errMsg, setErrMsg] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErrMsg(null)

    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          name: name.trim(),
          password,
        }),
      })
      const body = await res.json().catch(() => ({}))

      if (res.status === 403 && body.error === 'not_allowed') {
        router.replace(`/waitlist?email=${encodeURIComponent(email)}`)
        return
      }
      if (!res.ok) {
        setErrMsg(body.error || 'Sign-up failed.')
        setBusy(false)
        return
      }

      // Sign-up succeeded — automatically sign in.
      const signInRes = await signIn('credentials', {
        email: email.trim().toLowerCase(),
        password,
        redirect: false,
        callbackUrl: '/dashboard',
      })
      setBusy(false)
      if (signInRes?.error) {
        setErrMsg('Account created, but auto-sign-in failed. Try the sign-in page.')
        return
      }
      router.replace(signInRes?.url || '/dashboard')
    } catch (err: any) {
      setErrMsg(err?.message || 'Network error.')
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="font-display text-4xl text-ink-primary mb-2">JobPilot</h1>
          <p className="text-sm text-ink-tertiary">Create your account</p>
        </div>

        <div className="bg-white rounded-2xl border border-surface-200 p-6 shadow-sm">
          {errMsg && (
            <div className="mb-4 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
              {errMsg}
            </div>
          )}

          {/* Google */}
          <button
            type="button"
            onClick={() => signIn('google', { callbackUrl: '/dashboard' })}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-surface-200 bg-white hover:bg-surface-50 text-sm font-medium text-ink-primary transition-colors"
            disabled={busy}
          >
            <GoogleIcon /> Sign up with Google
          </button>

          <div className="flex items-center gap-3 my-4">
            <div className="flex-1 h-px bg-surface-200" />
            <span className="text-[10px] uppercase tracking-wider text-ink-muted font-semibold">Or</span>
            <div className="flex-1 h-px bg-surface-200" />
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
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
              <span className="text-[11px] text-ink-secondary font-medium">Password</span>
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="px-3 py-2 rounded-xl border border-surface-200 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100 transition-all"
                placeholder="At least 8 characters"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="mt-1 px-4 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
            >
              {busy ? 'Creating account…' : 'Create account'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-ink-tertiary mt-6">
          Already have an account?{' '}
          <Link href="/signin" className="text-brand-600 hover:text-brand-700 font-medium">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}

export default function SignUpPage() {
  return (
    <Suspense fallback={null}>
      <SignUpForm />
    </Suspense>
  )
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  )
}
