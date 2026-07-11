// Ophis: branded swap-completion audio cue.
//
// Upstream CoW ships a "moo" sound on order success plus send/error cues that
// are off-brand for Ophis, so the SEND and ERROR cues stay silenced (no-op
// stub). We DO play one branded sound the moment a swap (or bridge) order is
// FILLED, wired through getCowSoundSuccess() below. The trigger sites are
// chain-agnostic (soundMiddleware's fulfillOrdersBatch action + the bridge
// EXECUTED updater), so this plays on every chain (mainnet, Unichain,
// Optimism, ...) with no per-chain gating. The asset lives in public/audio and
// is served from the /audio/ root path on the deployed site.

type SoundType = 'SEND' | 'SUCCESS' | 'ERROR'
type Sounds = Record<SoundType, string>

const DEFAULT_SOUNDS: Sounds = {
  SEND: '/audio/send.mp3',
  SUCCESS: '/audio/lalala.mp3',
  ERROR: '/audio/error.mp3',
}

function getEmptySound(): HTMLAudioElement {
  if (typeof Audio !== 'undefined') {
    return new Audio('')
  }

  const stub: Partial<HTMLAudioElement> = {
    play: () => Promise.resolve(),
    pause: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }

  return stub as HTMLAudioElement
}

function getSound(type: SoundType): HTMLAudioElement {
  if (typeof Audio === 'undefined') {
    return getEmptySound()
  }

  return new Audio(DEFAULT_SOUNDS[type])
}

// SEND stays silenced (off-brand upstream cue).
export function getCowSoundSend(): HTMLAudioElement {
  return getEmptySound()
}

// SUCCESS plays the branded Ophis swap-completion cue on every chain.
export function getCowSoundSuccess(): HTMLAudioElement {
  return getSound('SUCCESS')
}

// ERROR stays silenced (off-brand upstream cue).
export function getCowSoundError(): HTMLAudioElement {
  return getEmptySound()
}

// Test util kept for compatibility with existing tests.
export const __soundTestUtils = {
  getThemeBasedSound: (type: SoundType): string => DEFAULT_SOUNDS[type],
} as const
