import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import {themes as prismThemes} from 'prism-react-renderer';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const SITE_URL = 'https://docs.ophis.fi';
const APP_URL = 'https://ophis.fi';
const BUSINESS_URL = 'https://business.ophis.fi';
const GITHUB_URL = 'https://github.com/ophis-fi/ophis';

const config: Config = {
  title: 'Ophis Docs',
  tagline: 'Describe a swap in plain English. A solver network fills it, MEV-protected.',
  favicon: 'img/ophis-icon.svg',

  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  url: SITE_URL,
  baseUrl: '/',

  // Deployed to Cloudflare Pages (project `ophis-docs`), not GitHub Pages.
  // These two only drive the "edit this page" / GitHub links.
  organizationName: 'ophis-fi',
  projectName: 'ophis',

  // A broken link or anchor fails the production build. This is the
  // primary correctness gate for a content site — treat it as the test
  // suite. Keep on 'throw'.
  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',

  // v4-style hook (replaces the deprecated top-level onBrokenMarkdownLinks).
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  // Geist + Geist Mono — same family the app adopted in PR #271. Loaded
  // from Google Fonts with a system fallback stack in custom.css, so the
  // site still renders cleanly if the font CDN is unreachable.
  headTags: [
    {tagName: 'link', attributes: {rel: 'preconnect', href: 'https://fonts.googleapis.com'}},
    {tagName: 'link', attributes: {rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: 'anonymous'}},
  ],
  stylesheets: [
    'https://fonts.googleapis.com/css2?family=Geist:wght@300..700&family=Geist+Mono:wght@400..600&display=swap',
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/', // docs-only mode — docs are served at the site root
          sidebarPath: './sidebars.ts',
          editUrl: `${GITHUB_URL}/tree/main/apps/docs-ophis/`,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
        sitemap: {
          changefreq: 'weekly',
          priority: 0.5,
        },
      } satisfies Preset.Options,
    ],
  ],

  // Offline, account-free full-text search (builds a local lunr index at
  // build time). Avoids the Algolia DocSearch account/API-key dependency.
  themes: [
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        indexDocs: true,
        indexBlog: false,
        indexPages: false,
        docsRouteBasePath: '/',
        highlightSearchTermsOnTargetPage: true,
        searchResultLimits: 8,
      },
    ],
  ],

  themeConfig: {
    image: 'img/og-image.png',
    metadata: [
      {
        name: 'description',
        content:
          'Ophis is an intent-based DEX aggregator: describe a swap in plain English and a solver network fills it MEV-protected. Docs cover the intent API, AI-agent integration, architecture, fees, and security.',
      },
      {
        name: 'keywords',
        content:
          'DEX aggregator, intent-based, MEV protection, batch auction, solver, NEAR Intents, CoW Protocol, intent API, AI agents',
      },
      {property: 'og:type', content: 'website'},
    ],
    colorMode: {
      // The Ophis brand is dark-first (cosmic palette). Default to dark;
      // the toggle still works for users who prefer light.
      defaultMode: 'dark',
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: 'Ophis Docs',
      logo: {
        alt: 'Ophis',
        src: 'img/ophis-icon.svg',
      },
      items: [
        {to: '/getting-started', label: 'Getting started', position: 'left'},
        {to: '/intent-api', label: 'Intent API', position: 'left'},
        {to: '/ai-agents', label: 'AI agents', position: 'left'},
        {type: 'search', position: 'right'},
        {href: APP_URL, label: 'Open app', position: 'right'},
        {href: BUSINESS_URL, label: 'Business', position: 'right'},
        {href: GITHUB_URL, label: 'GitHub', position: 'right'},
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Documentation',
          items: [
            {label: 'How it works', to: '/architecture'},
            {label: 'Fees & rebates', to: '/fees'},
            {label: 'Security & audits', to: '/audits'},
            {label: 'FAQ', to: '/faq'},
          ],
        },
        {
          title: 'Developers',
          items: [
            {label: 'Intent API', to: '/intent-api'},
            {label: 'AI agent integration', to: '/ai-agents'},
            {label: 'OpenAPI spec', href: `${APP_URL}/openapi.json`},
            {label: 'llms.txt', href: `${APP_URL}/llms.txt`},
          ],
        },
        {
          title: 'Product',
          items: [
            {label: 'Trade', href: APP_URL},
            {label: 'Learn', href: `${APP_URL}/#/learn`},
            {label: 'About', href: `${APP_URL}/#/about`},
            {label: 'Business', href: BUSINESS_URL},
          ],
        },
        {
          title: 'Company',
          items: [
            {label: 'Brand', href: `${APP_URL}/#/brand`},
            {label: 'Legal', href: `${APP_URL}/#/legal`},
            {label: 'Contact', href: `${APP_URL}/#/contact`},
            {label: 'GitHub', href: GITHUB_URL},
          ],
        },
      ],
      copyright: `Best-execution, MEV-protected trading from a plain-English intent. © Ophis ${new Date().getFullYear()}.`,
    },
    prism: {
      theme: prismThemes.oneLight,
      darkTheme: prismThemes.oneDark,
      additionalLanguages: ['bash', 'python', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
