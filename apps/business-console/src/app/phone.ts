// Owner, 2026-11-18: Ophis Business is for computers. A phone or tablet, as it names itself: Chromium's hint, else the
// user agent. The server (index.ts, every API call of both hosts), the console (main.tsx) and the signing page
// (sign/main.ts) apply this one test. One set to "desktop site" passes: this keeps Ophis Business off small screens,
// the passkey stays the lock.
export const PHONE_AGENT = /Mobi|Android|iPhone|iPad|iPod/i
export const onPhone = () =>
  (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile === true || PHONE_AGENT.test(navigator.userAgent)
