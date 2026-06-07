'use client'

import { SessionProvider } from 'next-auth/react'

/**
 * Wraps NextAuth's SessionProvider so children can call useSession() etc.
 * Lives in its own file because layout.tsx is a server component and
 * SessionProvider must run on the client.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>
}
