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
import { Dispatch, ReactNode, SetStateAction, useCallback, useEffect, useRef, useState } from 'react'

import { trackGa4Event } from 'ophis/analytics/track'
import { Callout, PageShell, Section, TextLink } from 'ophis/ds'
import styled from 'styled-components/macro'

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, params: { sitekey: string }) => string
      getResponse: (widgetId?: string) => string | undefined
      reset: (widgetId?: string) => void
      remove: (widgetId?: string) => void
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
  transition:
    background 120ms ease-out,
    transform 80ms ease-out,
    opacity 120ms ease-out;

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

interface TurnstileRefs {
  widgetIdRef: { current: string | undefined }
  widgetRef: { current: HTMLDivElement | null }
}

function useTurnstile(): TurnstileRefs {
  const widgetRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    const siteKey = TURNSTILE_SITE_KEY
    if (!siteKey) return
    let cancelled = false
    const key: string = siteKey

    function renderWidget(): void {
      if (cancelled || !widgetRef.current || !window.turnstile || widgetIdRef.current !== undefined) return
      widgetIdRef.current = window.turnstile.render(widgetRef.current, { sitekey: key })
    }

    if (window.turnstile) {
      renderWidget()
    } else {
      const existing = document.querySelector<HTMLScriptElement>(`script[src^="${TURNSTILE_SCRIPT_SRC}"]`)
      if (existing) {
        existing.addEventListener('load', renderWidget, { once: true })
      } else {
        const script = document.createElement('script')
        script.src = `${TURNSTILE_SCRIPT_SRC}?render=explicit`
        script.async = true
        script.defer = true
        script.addEventListener('load', renderWidget, { once: true })
        document.head.appendChild(script)
      }
    }

    return () => {
      cancelled = true
      if (widgetIdRef.current !== undefined) {
        window.turnstile?.remove(widgetIdRef.current)
        widgetIdRef.current = undefined
      }
    }
  }, [])

  return { widgetIdRef, widgetRef }
}

interface ContactFormModel {
  company: string
  email: string
  handleSubmit: (event: Event) => Promise<void>
  message: string
  name: string
  replyVia: string
  requestType: string
  setCompany: Dispatch<SetStateAction<string>>
  setEmail: Dispatch<SetStateAction<string>>
  setMessage: Dispatch<SetStateAction<string>>
  setName: Dispatch<SetStateAction<string>>
  setReplyVia: Dispatch<SetStateAction<string>>
  setRequestType: Dispatch<SetStateAction<string>>
  setTelegram: Dispatch<SetStateAction<string>>
  status: Status
  telegram: string
}

function useContactForm(widgetIdRef: TurnstileRefs['widgetIdRef']): ContactFormModel {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [telegram, setTelegram] = useState('')
  const [requestType, setRequestType] = useState('')
  const [replyVia, setReplyVia] = useState('Email')
  const [message, setMessage] = useState('')
  const [company, setCompany] = useState('') // honeypot
  const [status, setStatus] = useState<Status>('idle')

  const handleSubmit = useCallback(
    async (event: Event): Promise<void> => {
      event.preventDefault()
      if (status === 'sending') return

      let turnstileToken: string | undefined
      if (TURNSTILE_SITE_KEY) {
        turnstileToken = window.turnstile?.getResponse(widgetIdRef.current)
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
          // Conversion signal: a partner/contact lead was submitted. request_type
          // is a non-PII category; name/email/telegram/message are never sent.
          trackGa4Event('generate_lead', { method: 'contact_form', lead_type: requestType || 'general' })
          setName('')
          setEmail('')
          setTelegram('')
          setRequestType('')
          setReplyVia('Email')
          setMessage('')
        } else {
          setStatus('error')
          window.turnstile?.reset(widgetIdRef.current)
        }
      } catch {
        setStatus('error')
        window.turnstile?.reset()
      }
    },
    [company, email, message, name, replyVia, requestType, status, telegram, widgetIdRef],
  )

  return {
    company,
    email,
    handleSubmit,
    message,
    name,
    replyVia,
    requestType,
    setCompany,
    setEmail,
    setMessage,
    setName,
    setReplyVia,
    setRequestType,
    setTelegram,
    status,
    telegram,
  }
}

function useNativeSubmitHandler(handleSubmit: ContactFormModel['handleSubmit']): { current: HTMLFormElement | null } {
  const formRef = useRef<HTMLFormElement>(null)
  useEffect(() => {
    const form = formRef.current
    if (!form) return
    const listener = (event: Event): void => void handleSubmit(event)
    form.addEventListener('submit', listener)
    return () => form.removeEventListener('submit', listener)
  }, [handleSubmit])
  return formRef
}

function ContactIdentityFields({ model }: { model: ContactFormModel }): ReactNode {
  return (
    <>
      <Field>
        Name
        <Input
          type="text"
          name="name"
          value={model.name}
          onChange={(event) => model.setName(event.target.value)}
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
          value={model.email}
          onChange={(event) => model.setEmail(event.target.value)}
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
          value={model.telegram}
          onChange={(event) => model.setTelegram(event.target.value)}
          maxLength={64}
          placeholder="@yourhandle"
        />
      </Field>
      <Field>
        Type of request
        <Select
          name="request_type"
          value={model.requestType}
          onChange={(event) => model.setRequestType(event.target.value)}
          required
        >
          <option value="" disabled>
            Select a topic…
          </option>
          {REQUEST_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </Select>
      </Field>
      <Field>
        Preferred reply
        <Select name="reply_via" value={model.replyVia} onChange={(event) => model.setReplyVia(event.target.value)}>
          <option value="Email">Email</option>
          <option value="Telegram">Telegram</option>
        </Select>
      </Field>
      <Field>
        Message
        <Textarea
          name="message"
          value={model.message}
          onChange={(event) => model.setMessage(event.target.value)}
          required
          maxLength={4000}
          placeholder="How can we help?"
        />
      </Field>
    </>
  )
}

function ContactFormContent({
  model,
  widgetRef,
}: {
  model: ContactFormModel
  widgetRef: TurnstileRefs['widgetRef']
}): ReactNode {
  const formRef = useNativeSubmitHandler(model.handleSubmit)

  return (
    <Form ref={formRef} action={FORMSPREE_ENDPOINT} method="POST">
      <ContactIdentityFields model={model} />
      <input type="hidden" name="_subject" value="New Ophis contact form submission" />
      <Honeypot aria-hidden="true">
        <label>
          Company
          <input
            type="text"
            name="_gotcha"
            tabIndex={-1}
            autoComplete="off"
            value={model.company}
            onChange={(event) => model.setCompany(event.target.value)}
          />
        </label>
      </Honeypot>
      {TURNSTILE_SITE_KEY && <TurnstileWidget ref={widgetRef} />}
      {model.status === 'captcha' && (
        <Callout tone="warning" title="Verification needed">
          <p>Please complete the anti-spam check above, then send again.</p>
        </Callout>
      )}
      {model.status === 'error' && (
        <Callout tone="warning" title="Could not send">
          <p>
            Something went wrong sending your message. Please try again in a moment, or reach us via{' '}
            <TextLink href="https://github.com/ophis-fi/ophis" external>
              GitHub
            </TextLink>
            .
          </p>
        </Callout>
      )}
      <SubmitButton type="submit" disabled={model.status === 'sending'}>
        {model.status === 'sending' ? 'Sending…' : 'Send message'}
      </SubmitButton>
    </Form>
  )
}

export function ContactPage(): ReactNode {
  const { widgetIdRef, widgetRef } = useTurnstile()
  const model = useContactForm(widgetIdRef)

  return (
    <PageShell
      width="medium"
      eyebrow="Contact"
      title="Get in touch."
      lede="Partnerships, integrations, institutional desks, press, or support. Tell us what you need and how to reach you, and the right person on the Ophis team gets back to you."
    >
      <Section id="form" title="Send a message">
        {model.status === 'success' ? (
          <Callout tone="success" title="Message sent">
            <p>
              Thanks, your message is on its way. We&apos;ll reply via your preferred channel. For institutional or desk
              enquiries in the meantime, see{' '}
              <TextLink href="https://business.ophis.fi" external>
                business.ophis.fi
              </TextLink>
              .
            </p>
          </Callout>
        ) : (
          <ContactFormContent model={model} widgetRef={widgetRef} />
        )}
      </Section>
    </PageShell>
  )
}
