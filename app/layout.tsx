import type { Metadata } from 'next'
import { DM_Serif_Display } from 'next/font/google'
import localFont from 'next/font/local'
import './globals.css'

const dmSerif = DM_Serif_Display({
  weight: ['400'],
  subsets: ['latin'],
  variable: '--font-display',
})

export const metadata: Metadata = {
  title: 'JobPilot — Auto Apply Dashboard',
  description: 'Automated job scraping and application tracker for PM, APM, BA roles',
  manifest: '/manifest.json',
  viewport: 'width=device-width, initial-scale=1, maximum-scale=1',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${dmSerif.variable}`}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
      </head>
      <body className="bg-surface-50 text-ink-primary antialiased">
        {children}
      </body>
    </html>
  )
}
