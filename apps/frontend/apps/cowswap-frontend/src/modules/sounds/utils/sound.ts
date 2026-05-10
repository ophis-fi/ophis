// Greg/Ophis: silence upstream audio cues.
//
// Ophis shipped a "moo" sound on order success and other branded
// audio cues that are off-brand for Ophis. Rather than ship audio
// files we don't yet have, these helpers return a no-op audio stub.
// Replace with Ophis sound design later — keep the named exports so
// the sound middleware doesn't need refactoring.

type SoundType = 'SEND' | 'SUCCESS' | 'ERROR'
type Sounds = Record<SoundType, string>

const DEFAULT_SOUNDS: Sounds = {
  SEND: '/audio/send.mp3',
  SUCCESS: '/audio/success.mp3',
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

export function getCowSoundSend(): HTMLAudioElement {
  return getEmptySound()
}

export function getCowSoundSuccess(): HTMLAudioElement {
  return getEmptySound()
}

export function getCowSoundError(): HTMLAudioElement {
  return getEmptySound()
}

// Test util kept for compatibility with existing tests.
export const __soundTestUtils = {
  getThemeBasedSound: (type: SoundType): string => DEFAULT_SOUNDS[type],
} as const
