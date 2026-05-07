import { isInjectedWidget } from '@cowprotocol/common-utils'
import { jotaiStore } from '@cowprotocol/core'
import { CowSwapWidgetAppParams } from '@cowprotocol/widget-lib'

import { injectedWidgetParamsAtom } from 'modules/injectedWidget/state/injectedWidgetParamsAtom'

type SoundType = 'SEND' | 'SUCCESS' | 'ERROR'
type Sounds = Record<SoundType, string>
type WidgetSounds = keyof NonNullable<CowSwapWidgetAppParams['sounds']>

const DEFAULT_SOUNDS: Sounds = {
  SEND: '/audio/send.mp3',
  SUCCESS: '/audio/success.mp3',
  ERROR: '/audio/error.mp3',
}

const SOUND_TO_WIDGET_KEY: Record<SoundType, WidgetSounds> = {
  SEND: 'postOrder',
  SUCCESS: 'orderExecuted',
  ERROR: 'orderError',
}

const SOUND_CACHE: Record<string, HTMLAudioElement | undefined> = {}

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

function createAudioOrEmpty(src: string): HTMLAudioElement {
  return typeof Audio !== 'undefined' ? new Audio(src) : getEmptySound()
}

function getWidgetSoundUrl(type: SoundType): string | null | undefined {
  const { params } = jotaiStore.get(injectedWidgetParamsAtom)
  const key = SOUND_TO_WIDGET_KEY[type]

  return params?.sounds?.[key]
}

function getAudio(type: SoundType): HTMLAudioElement {
  const widgetSound = getWidgetSoundUrl(type)
  const isWidgetMode = isInjectedWidget()

  if (isWidgetMode && widgetSound === null) {
    return getEmptySound()
  }

  const soundPath = (isWidgetMode && widgetSound) || DEFAULT_SOUNDS[type]
  let sound = SOUND_CACHE[soundPath]

  if (!sound) {
    sound = createAudioOrEmpty(soundPath)
    SOUND_CACHE[soundPath] = sound
  }

  return sound
}

export function getCowSoundSend(): HTMLAudioElement {
  return getAudio('SEND')
}

export function getCowSoundSuccess(): HTMLAudioElement {
  return getAudio('SUCCESS')
}

export function getCowSoundError(): HTMLAudioElement {
  return getAudio('ERROR')
}

export const __soundTestUtils = {
  getThemeBasedSound: (type: SoundType): string => DEFAULT_SOUNDS[type],
} as const
