import type { EIP1193Provider, EIP6963ProviderDetail } from '@cowprotocol/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeRdns(value: string): string {
  return value.trim().toLowerCase()
}

export function areEip6963RdnsEqual(left: unknown, right: unknown): boolean {
  return isNonEmptyString(left) && isNonEmptyString(right) && normalizeRdns(left) === normalizeRdns(right)
}

function isEip1193Provider(value: unknown): value is EIP1193Provider {
  return isRecord(value) && typeof value.request === 'function'
}

export function isEip6963ProviderDetail(value: unknown): value is EIP6963ProviderDetail {
  if (!isRecord(value) || !isRecord(value.info)) return false

  const { info, provider } = value

  return (
    isNonEmptyString(info.uuid) &&
    isNonEmptyString(info.name) &&
    isNonEmptyString(info.icon) &&
    isNonEmptyString(info.rdns) &&
    isEip1193Provider(provider)
  )
}

function isSameAnnouncement(left: EIP6963ProviderDetail, right: EIP6963ProviderDetail): boolean {
  return (
    left.provider === right.provider &&
    left.info.uuid === right.info.uuid &&
    left.info.name === right.info.name &&
    left.info.icon === right.info.icon &&
    normalizeRdns(left.info.rdns) === normalizeRdns(right.info.rdns)
  )
}

/**
 * Add or refresh one announced provider. The UI intentionally keeps one entry
 * per wallet RDNS, while UUID replacement refreshes an injected provider whose
 * object changed during the page lifetime.
 */
export function upsertEip6963Provider(
  providers: EIP6963ProviderDetail[],
  announcement: unknown,
): EIP6963ProviderDetail[] {
  if (!isEip6963ProviderDetail(announcement)) return providers

  const announcedRdns = normalizeRdns(announcement.info.rdns)
  const existing = providers.find(
    ({ info }) => info.uuid === announcement.info.uuid || normalizeRdns(info.rdns) === announcedRdns,
  )

  if (existing && isSameAnnouncement(existing, announcement)) return providers

  return [
    announcement,
    ...providers.filter(
      ({ info }) => info.uuid !== announcement.info.uuid && normalizeRdns(info.rdns) !== announcedRdns,
    ),
  ]
}

export function findEip6963ProviderByRdns(
  providers: readonly EIP6963ProviderDetail[],
  selectedRdns: unknown,
): EIP6963ProviderDetail | null {
  if (!isNonEmptyString(selectedRdns)) return null

  return providers.find(({ info }) => areEip6963RdnsEqual(info.rdns, selectedRdns)) ?? null
}
