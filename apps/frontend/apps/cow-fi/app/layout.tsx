import type { ReactNode } from 'react'

import { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'

import { Providers } from './providers'

import { CONFIG } from '@/const/meta'
import { checkEnvironment } from '@/util/environment'
import { getPageMetadata } from '@/util/getPageMetadata'

export const viewport: Viewport = {
  themeColor: '#E66A55',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
}

const defaultMetadata = getPageMetadata({ description: CONFIG.description })

export async function generateMetadata(): Promise<Metadata> {
  const headersList = await headers()
  const host = headersList.get('host') || ''
  const { isDev, isPr } = checkEnvironment(host, '')

  return {
    ...defaultMetadata,
    metadataBase: new URL(CONFIG.url.root),
    alternates: { canonical: './' },
    // Add noindex for develop.cow.fi and PR preview environments to prevent search engine indexing
    robots:
      isDev || isPr
        ? {
            index: false,
            follow: false,
            noarchive: true,
            nosnippet: true,
          }
        : {
            index: true,
            follow: true,
          },
    icons: {
      icon: [
        { url: '/greg-icon.svg', type: 'image/svg+xml' },
        { url: '/greg-icon-inverse.svg', type: 'image/svg+xml', media: '(prefers-color-scheme: dark)' },
      ],
      apple: '/greg-mark-app-icon.svg',
      other: {
        rel: 'mask-icon',
        url: '/greg-icon.svg',
        color: '#E66A55',
      },
    },
    twitter: {
      ...defaultMetadata.twitter,
      card: 'summary_large_image',
      site: CONFIG.social.twitter.account,
      images: [{ url: `${CONFIG.url.root}/og-image.png` }],
    },
    openGraph: {
      ...defaultMetadata.openGraph,
      type: 'website',
      url: './',
      images: [{ url: `${CONFIG.url.root}/og-image.png` }],
    },
    manifest: '/site.webmanifest',
    other: {
      'msapplication-TileColor': '#E66A55',
    },
  }
}

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
