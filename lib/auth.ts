import { NextAuthOptions } from 'next-auth'
import { PrismaAdapter } from '@auth/prisma-adapter'
import CredentialsProvider from 'next-auth/providers/credentials'
import GoogleProvider from 'next-auth/providers/google'
import { compare } from 'bcryptjs'
import prisma from './db'

/**
 * NextAuth options used by the [...nextauth] route handler.
 *
 * Two providers:
 *   1. Credentials — email + password. Password is bcrypt-hashed in the User
 *      table.
 *   2. Google OAuth — for one-click sign-in. Requires GOOGLE_CLIENT_ID and
 *      GOOGLE_CLIENT_SECRET env vars.
 *
 * Allowlist gate: a user can only sign in / sign up if their email is in
 * the EmailAllowlist table. This is enforced in the `signIn` callback below;
 * unlisted emails are rejected by NextAuth and the sign-in page handles the
 * redirect to /waitlist.
 *
 * Session strategy: JWT (not database sessions). Why JWT? Each API route
 * already does `getServerSession(authOptions)` once, and JWT avoids an extra
 * Session-table read per request. The Session table in the schema exists
 * because the PrismaAdapter declares it; it'll stay empty under the JWT
 * strategy and that's fine.
 *
 * On first sign-in we auto-create a Profile row for the user (via the
 * `events.createUser` callback below). The profile starts blank and the
 * user fills it in via the Settings page.
 */
export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma) as any,
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  pages: {
    signIn:  '/signin',
    error:   '/signin',  // surface auth errors back on the signin page
  },
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email:    { label: 'Email',    type: 'email'    },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null
        const user = await prisma.user.findUnique({
          where: { email: credentials.email.toLowerCase().trim() },
        })
        if (!user || !user.passwordHash) return null
        const ok = await compare(credentials.password, user.passwordHash)
        if (!ok) return null
        await prisma.user.update({
          where: { id: user.id },
          data:  { lastSignInAt: new Date() },
        }).catch(() => {}) // non-critical
        return {
          id:    user.id,
          email: user.email,
          name:  user.name ?? null,
          image: user.image ?? null,
        }
      },
    }),
    // Google OAuth is optional — only enabled if both env vars are present.
    // Keeps local dev working without Google setup.
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [
          GoogleProvider({
            clientId:     process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          }),
        ]
      : []),
  ],
  callbacks: {
    /**
     * Allowlist gate. Runs before any session is created. Returning false
     * here causes NextAuth to redirect back to /signin?error=AccessDenied,
     * which the signin page reinterprets as "send them to /waitlist".
     */
    async signIn({ user }) {
      const email = (user.email || '').toLowerCase().trim()
      if (!email) return false
      const allowed = await prisma.emailAllowlist.findUnique({ where: { email } })
      return !!allowed
    },
    /**
     * Stash the user id on the JWT so every API route can read it via
     * `(await getServerSession(authOptions))?.user?.id` without hitting the
     * DB. We also re-read role on every JWT mint so admin-promotion takes
     * effect on next sign-in without forcing a sign-out.
     */
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
      }
      if (token.id) {
        const dbUser = await prisma.user.findUnique({
          where:  { id: token.id as string },
          select: { role: true },
        }).catch(() => null)
        if (dbUser) token.role = dbUser.role
      }
      return token
    },
    async session({ session, token }) {
      if (session.user && token.id) {
        ;(session.user as any).id   = token.id
        ;(session.user as any).role = token.role
      }
      return session
    },
  },
  events: {
    /**
     * Auto-create a blank Profile row on first sign-up. Without this, every
     * code path that reads `prisma.profile.findUnique({ where: { userId } })`
     * needs to handle null, which is annoying. Better to guarantee the row
     * exists from day 1.
     */
    async createUser({ user }) {
      await prisma.profile.create({
        data: {
          userId: user.id,
          email:  user.email ?? null,
          fullName: user.name ?? null,
        },
      }).catch(() => {}) // race-safe: ignore if already created
    },
  },
}

/** Helper: get the current user id, or null if not signed in. Use this
 *  inside API routes instead of repeating the getServerSession dance.
 *  Throws if used outside an authed route — call from inside a try/catch. */
export async function getCurrentUserId(): Promise<string | null> {
  const { getServerSession } = await import('next-auth/next')
  const session = await getServerSession(authOptions)
  return (session?.user as any)?.id ?? null
}
