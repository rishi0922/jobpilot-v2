import type { Metadata, Viewport } from 'next'
import { DM_Serif_Display } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'

const dmSerif = DM_Serif_Display({
  weight: ['400'],
  subsets: ['latin'],
  variable: '--font-display',
})

export const metadata: Metadata = {
  title: 'JobPilot — Auto Apply Dashboard',
  description: 'Automated job scraping and application tracker for PM, APM, BA roles',
  manifest: '/manifest.json',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${dmSerif.variable}`}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
      </head>
      <body className="bg-surface-50 text-ink-primary antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
