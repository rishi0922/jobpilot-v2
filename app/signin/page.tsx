'use client'

import { useState, useEffect, Suspense } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'

/**
 * Sign-in page. Two paths:
 *   1. Email + password (NextAuth Credentials provider).
 *   2. "Sign in with Google" (NextAuth Google provider, only shown if the
 *      env vars are set — the button is rendered unconditionally here, but
 *      clicking it when no provider is configured will fail cleanly with an
 *      error redirect).
 *
 * The NextAuth signIn callback rejects emails not in EmailAllowlist with an
 * "AccessDenied" error. We detect that on the URL and redirect to /waitlist
 * so the user has somewhere to go instead of a cryptic message.
 */
function SignInForm() {
  const router = useRouter()
  const sp = useSearchParams()
  const callbackUrl = sp?.get('callbackUrl') || '/dashboard'
  const error = sp?.get('error')

  const [email, setEmail] = useState(sp?.get('email') || '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [errMsg, setErrMsg] = useState<string | null>(null)

  // NextAuth surfaces allowlist rejections as ?error=AccessDenied.
  // Redirect those to /waitlist with the email pre-filled if we have it.
  useEffect(() => {
    if (error === 'AccessDenied') {
      router.replace(`/waitlist${email ? `?email=${encodeURIComponent(email)}` : ''}`)
    }
  }, [error, email, router])

  // Pretty-print the other errors NextAuth might send back
  useEffect(() => {
    if (!error || error === 'AccessDenied') return
    const map: Record<string, string> = {
      CredentialsSignin: 'Invalid email or password.',
      OAuthAccountNotLinked: 'That email is already registered with a different sign-in method.',
      OAuthSignin: 'Google sign-in failed. Try again or use email + password.',
      OAuthCallback: 'Google sign-in failed. Try again.',
      Default: 'Sign-in failed. Try again.',
    }
    setErrMsg(map[error] || map.Default)
  }, [error])

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErrMsg(null)
    const res = await signIn('credentials', {
      email: email.trim().toLowerCase(),
      password,
      redirect: false,
      callbackUrl,
    })
    setBusy(false)
    if (res?.error) {
      // CredentialsSignin = bad password OR allowlist rejection (the
      // authorize callback returns null in both cases).
      if (res.error === 'AccessDenied') {
        router.replace(`/waitlist?email=${encodeURIComponent(email)}`)
      } else {
        setErrMsg('Invalid email or password.')
      }
      return
    }
    // Success
    router.replace(res?.url || callbackUrl)
  }

  return (
    <div className="min-h-screen bg-surface-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Brand header */}
        <div className="text-center mb-8">
          <h1 className="font-display text-4xl text-ink-primary mb-2">JobPilot</h1>
          <p className="text-sm text-ink-tertiary">Sign in to your dashboard</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl border border-surface-200 p-6 shadow-sm">
          {errMsg && (
            <div className="mb-4 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
              {errMsg}
            </div>
          )}

          {/* Google */}
          <button
            type="button"
            onClick={() => signIn('google', { callbackUrl })}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-surface-200 bg-white hover:bg-surface-50 text-sm font-medium text-ink-primary transition-colors"
            disabled={busy}
          >
            <GoogleIcon /> Continue with Google
          </button>

          {/* Divider */}
          <div className="flex items-center gap-3 my-4">
            <div className="flex-1 h-px bg-surface-200" />
            <span className="text-[10px] uppercase tracking-wider text-ink-muted font-semibold">Or</span>
            <div className="flex-1 h-px bg-surface-200" />
          </div>

          {/* Email + password */}
          <form onSubmit={handleEmailSubmit} className="flex flex-col gap-3">
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
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="px-3 py-2 rounded-xl border border-surface-200 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100 transition-all"
                placeholder="••••••••"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="mt-1 px-4 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-ink-tertiary mt-6">
          Don&rsquo;t have an account?{' '}
          <Link href="/signup" className="text-brand-600 hover:text-brand-700 font-medium">
            Create one
          </Link>
        </p>
      </div>
    </div>
  )
}

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  )
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  )
}
