import { withAuth } from 'next-auth/middleware'

/**
 * NextAuth's edge middleware. Runs on every request matching the `config.matcher`
 * paths below and redirects unauthenticated visitors to the sign-in page.
 *
 * The matcher deliberately covers ONLY user-facing pages, NOT /api/* routes —
 * those handle their own auth via getCurrentUserId() and would otherwise
 * double-401 with a redirect to the HTML signin page (which a JSON caller
 * can't parse).
 */
export default withAuth({
  pages: {
    signIn: '/signin',
  },
})

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/settings/:path*',
  ],
}
