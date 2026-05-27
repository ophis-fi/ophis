/**
 * Contact form. Submits to Formspree (no email address rendered anywhere on the
 * site; the form is the only contact affordance). Captures a request type +
 * optional Telegram handle + preferred reply channel so messages are easy to
 * triage and respond to.
 *
 * Anti-spam: (1) a hidden _gotcha honeypot, and (2) Cloudflare Turnstile when
 * REACT_APP_TURNSTILE_SITE_KEY is set — the token is sent as cf-turnstile-response
 * and verified by Formspree (configure the Turnstile SECRET in the Formspree form
 * settings). A verified token both blocks bots and stops legit messages being
 * marked as spam. Turnstile is env-gated: with no site key the form still works
 * (honeypot + Formspree's own ML filter).
 *
 * AGENTS.md compliance: named export, page implementation in *.container.tsx,
 * barrel re-export in index.ts.
 */
import { FormEvent, ReactNode, useEffect, useState } from 'react'

import styled from 'styled-components/macro'

import { Callout, PageShell, Section, TextLink } from 'ophis/ds'

declare global {
  interface Window {
    turnstile?: {
      getResponse: (widgetId?: string) => string | undefined
      reset: (widgetId?: string) => void
    }
  }
}

// Formspree PUBLIC project-form endpoint (safe client-side; it's the form action
// URL). NOT the deploy key, which is a secret used only by the Formspree CLI in
// CI (FORMSPREE_DEPLOY_KEY) and must never appear in client code. Form config
// lives in formspree.json (form key "contact"), deployed by the CLI.
const FORMSPREE_ENDPOINT = 'https://formspree.io/p/3010910624528989815/f/contact'

// Cloudflare Turnstile site key (PUBLIC, safe client-side). Build-time injected.
// Pair it with the matching SECRET key configured in the Formspree form settings.
// Unset → Turnstile is skipped (form still works via honeypot + Formspree ML).
const TURNSTILE_SITE_KEY = process.env.REACT_APP_TURNSTILE_SITE_KEY

const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js'

const REQUEST_TYPES = [
  'Partnership / integration',
  'Institutional / OTC desk',
  'Developer / API',
  'Press / media',
  'Support / bug report',
  'Other',
] as const

type Status = 'idle' | 'sending' | 'success' | 'error' | 'captcha'

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 560px;
`

const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-family: 'Geist', var(--cow-font-family-primary, system-ui);
  font-size: 14px;
  font-weight: 500;
  color: rgba(245, 239, 230, 0.85);
`

const inputChrome = `
  font-family: 'Geist', var(--cow-font-family-primary, system-ui);
  font-size: 15px;
  color: #f5efe6;
  background: rgba(8, 4, 24, 0.5);
  border: 1px solid rgba(245, 239, 230, 0.18);
  border-radius: 12px;
  padding: 12px 14px;
  transition: border-color 120ms ease-out, box-shadow 120ms ease-out;

  &::placeholder {
    color: rgba(245, 239, 230, 0.4);
  }
  &:focus {
    outline: none;
    border-color: #f2a63e;
    box-shadow: 0 0 0 3px rgba(242, 166, 62, 0.18);
  }
`

const Input = styled.input`
  ${inputChrome}
`

const Select = styled.select`
  ${inputChrome}
  cursor: pointer;
  /* Dark options on the few platforms that honor it; the closed control is
     always styled by inputChrome. */
  & option {
    color: #02000d;
  }
`

const Textarea = styled.textarea`
  ${inputChrome}
  min-height: 150px;
  resize: vertical;
`

// Off-screen honeypot. Real users never see or fill it; naive bots that
// auto-fill every field trip it and Formspree drops the submission.
const Honeypot = styled.div`
  position: absolute;
  left: -9999px;
  width: 1px;
  height: 1px;
  overflow: hidden;
`

const TurnstileWidget = styled.div`
  min-height: 65px;
`

const SubmitButton = styled.button`
  appearance: none;
  align-self: flex-start;
  border: none;
  border-radius: 999px;
  padding: 13px 30px;
  font-family: 'Geist', var(--cow-font-family-primary, system-ui);
  font-size: 15px;
  font-weight: 700;
  color: #02000d;
  background: #f2a63e;
  cursor: pointer;
  transition: background 120ms ease-out, transform 80ms ease-out, opacity 120ms ease-out;

  &:hover:not(:disabled) {
    background: #ffbb6e;
  }
  &:active:not(:disabled) {
    transform: translateY(1px);
  }
  &:disabled {
    opacity: 0.55;
    cursor: default;
  }
`

export function ContactPage(): ReactNode {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [telegram, setTelegram] = useState('')
  const [requestType, setRequestType] = useState('')
  const [replyVia, setReplyVia] = useState('Email')
  const [message, setMessage] = useState('')
  const [company, setCompany] = useState('') // honeypot
  const [status, setStatus] = useState<Status>('idle')

  // Load the Turnstile script once, only when a site key is configured.
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return
    if (document.querySelector(`script[src="${TURNSTILE_SCRIPT_SRC}"]`)) return
    const script = document.createElement('script')
    script.src = TURNSTILE_SCRIPT_SRC
    script.async = true
    script.defer = true
    document.head.appendChild(script)
  }, [])

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (status === 'sending') return

    let turnstileToken: string | undefined
    if (TURNSTILE_SITE_KEY) {
      turnstileToken = window.turnstile?.getResponse()
      if (!turnstileToken) {
        setStatus('captcha')
        return
      }
    }

    setStatus('sending')
    try {
      const res = await fetch(FORMSPREE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          name,
          email,
          telegram,
          request_type: requestType,
          reply_via: replyVia,
          message,
          _subject: `Ophis contact [${requestType || 'General'}]: ${name}`,
          _gotcha: company,
          ...(turnstileToken ? { 'cf-turnstile-response': turnstileToken } : {}),
        }),
      })
      if (res.ok) {
        setStatus('success')
        setName('')
        setEmail('')
        setTelegram('')
        setRequestType('')
        setReplyVia('Email')
        setMessage('')
      } else {
        setStatus('error')
        window.turnstile?.reset()
      }
    } catch {
      setStatus('error')
      window.turnstile?.reset()
    }
  }

  return (
    <PageShell
      width="medium"
      eyebrow="Contact"
      title="Get in touch."
      lede="Partnerships, integrations, institutional desks, press, or support. Tell us what you need and how to reach you, and the right person on the Ophis team gets back to you."
    >
      <Section id="form" title="Send a message">
        {status === 'success' ? (
          <Callout tone="success" title="Message sent">
            <p>
              Thanks, your message is on its way. We&apos;ll reply via your preferred channel. For
              institutional or desk enquiries in the meantime, see{' '}
              <TextLink href="https://business.ophis.fi" external>
                business.ophis.fi
              </TextLink>
              .
            </p>
          </Callout>
        ) : (
          <Form onSubmit={handleSubmit} action={FORMSPREE_ENDPOINT} method="POST">
            <Field>
              Name
              <Input
                type="text"
                name="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
                placeholder="Your name"
                autoComplete="name"
              />
            </Field>
            <Field>
              Email
              <Input
                type="email"
                name="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                maxLength={254}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </Field>
            <Field>
              Telegram handle <span style={{ fontWeight: 400, opacity: 0.6 }}>(optional)</span>
              <Input
                type="text"
                name="telegram"
                value={telegram}
                onChange={(e) => setTelegram(e.target.value)}
                maxLength={64}
                placeholder="@yourhandle"
              />
            </Field>
            <Field>
              Type of request
              <Select
                name="request_type"
                value={requestType}
                onChange={(e) => setRequestType(e.target.value)}
                required
              >
                <option value="" disabled>
                  Select a topic…
                </option>
                {REQUEST_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              Preferred reply
              <Select name="reply_via" value={replyVia} onChange={(e) => setReplyVia(e.target.value)}>
                <option value="Email">Email</option>
                <option value="Telegram">Telegram</option>
              </Select>
            </Field>
            <Field>
              Message
              <Textarea
                name="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                required
                maxLength={4000}
                placeholder="How can we help?"
              />
            </Field>

            {/* Native-fallback subject (no-JS path); the AJAX path sends a richer
                dynamic _subject built from the request type. */}
            <input type="hidden" name="_subject" value="New Ophis contact form submission" />

            <Honeypot aria-hidden="true">
              <label>
                Company
                <input
                  type="text"
                  name="_gotcha"
                  tabIndex={-1}
                  autoComplete="off"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                />
              </label>
            </Honeypot>

            {TURNSTILE_SITE_KEY && (
              <TurnstileWidget className="cf-turnstile" data-sitekey={TURNSTILE_SITE_KEY} />
            )}

            {status === 'captcha' && (
              <Callout tone="warning" title="Verification needed">
                <p>Please complete the anti-spam check above, then send again.</p>
              </Callout>
            )}

            {status === 'error' && (
              <Callout tone="warning" title="Could not send">
                <p>
                  Something went wrong sending your message. Please try again in a moment, or reach
                  us via{' '}
                  <TextLink href="https://github.com/ophis-fi/ophis" external>
                    GitHub
                  </TextLink>
                  .
                </p>
              </Callout>
            )}

            <SubmitButton type="submit" disabled={status === 'sending'}>
              {status === 'sending' ? 'Sending…' : 'Send message'}
            </SubmitButton>
          </Form>
        )}
      </Section>
    </PageShell>
  )
}
