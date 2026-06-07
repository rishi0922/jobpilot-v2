import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'

/**
 * Root route — sends signed-in users to /dashboard, everyone else to /signin.
 * No marketing splash for now; if a non-allowlisted user lands here,
 * they'll click "Don't have an account?" on /signin and hit /signup,
 * which redirects them to /waitlist when the allowlist check fails.
 */
export default async function Home() {
  const session = await getServerSession(authOptions)
  if (session) redirect('/dashboard')
  redirect('/signin')
}
