export function normalizeName(name: string): string {
  // Use Unicode property escapes so non-Latin scripts (Arabic, Urdu, Devanagari, CJK, etc.)
  // are kept instead of being stripped to an empty string.
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-().+]/g, '').toLowerCase()
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname}${u.pathname}`.replace(/\/$/, '').toLowerCase()
  } catch {
    return url.toLowerCase().trim()
  }
}

export function normalizeAddress(address: string): string {
  return address
    .toLowerCase()
    .replace(/[,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractMapsPlaceId(mapsUrl: string): string | null {
  const match = mapsUrl.match(/place\/[^/]+\/(@[^/]+)/)
  return match ? match[1] : null
}
