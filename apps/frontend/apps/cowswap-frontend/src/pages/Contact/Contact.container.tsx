/**
 * Contact, a simple message form that submits to Formspree. No email address
 * is rendered anywhere on the site; the form is the only contact affordance.
 *
 * AGENTS.md compliance: named export, page implementation in *.container.tsx,
 * barrel re-export in index.ts.
 */
import { FormEvent, ReactNode, useState } from 'react'

import styled from 'styled-components/macro'

import { Callout, PageShell, Section, TextLink } from 'ophis/ds'

// Formspree form endpoint (public by design, lives client-side). Submissions
// email the Ophis inbox; Formspree handles delivery + spam filtering, plus the
// _gotcha honeypot below. Swap the id here if the Formspree form changes.
const FORMSPREE_ENDPOINT = 'https://formspree.io/f/421f903a6d1346f9bd3b957974e7bb57'

type Status = 'idle' | 'sending' | 'success' | 'error'

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

const Textarea = styled.textarea`
  ${inputChrome}
  min-height: 150px;
  resize: vertical;
`

// Off-screen honeypot. Real users never see or fill it; bots that
// auto-fill every field trip it and the submission is silently dropped
// server-side. aria-hidden + tabIndex -1 keep it out of the a11y tree.
const Honeypot = styled.div`
  position: absolute;
  left: -9999px;
  width: 1px;
  height: 1px;
  overflow: hidden;
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
  const [message, setMessage] = useState('')
  const [company, setCompany] = useState('') // honeypot
  const [status, setStatus] = useState<Status>('idle')

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (status === 'sending') return
    setStatus('sending')
    try {
      const res = await fetch(FORMSPREE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name, email, message, _gotcha: company }),
      })
      if (res.ok) {
        setStatus('success')
        setName('')
        setEmail('')
        setMessage('')
      } else {
        setStatus('error')
      }
    } catch {
      setStatus('error')
    }
  }

  return (
    <PageShell
      width="medium"
      eyebrow="Contact"
      title="Get in touch."
      lede="Questions, partnerships, integrations, or feedback. Send a message and it reaches the Ophis team directly. For institutional and desk enquiries, see the business page."
    >
      <Section id="form" title="Send a message">
        {status === 'success' ? (
          <Callout tone="success" title="Message sent">
            <p>
              Thanks, your message is on its way. We&apos;ll reply to the email you provided. For
              institutional or desk enquiries in the meantime, see{' '}
              <TextLink href="https://business.ophis.fi" external>
                business.ophis.fi
              </TextLink>
              .
            </p>
          </Callout>
        ) : (
          <Form onSubmit={handleSubmit}>
            <Field>
              Name
              <Input
                type="text"
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
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                maxLength={254}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </Field>
            <Field>
              Message
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                required
                maxLength={4000}
                placeholder="How can we help?"
              />
            </Field>

            <Honeypot aria-hidden="true">
              <label>
                Company
                <input
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                />
              </label>
            </Honeypot>

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
