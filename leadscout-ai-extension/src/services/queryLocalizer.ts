// ── Localized query generator ─────────────────────────────────────────────────
// Generates search queries in the target country's local language(s) alongside
// English. Google returns different result sets per query language, so Arabic
// queries surface Omani businesses that English queries never show (and vice
// versa). Used by both the Maps capture queue and the evidence search step.

import { getCountryIntelligence } from '@/config/countryIntelligence'

export interface LocalizedQuery {
  query: string
  /** ISO 639-1 language code of the query text */
  language: string
}

// Keyword translation table — business keywords in local languages.
// Keyed by language code, then by a lowercase English keyword *fragment*.
// A keyword matches if it contains the fragment (so "commercial printing
// services" matches the "printing" entry).
const KEYWORD_TRANSLATIONS: Record<string, Array<{ match: RegExp; local: string }>> = {
  ar: [
    { match: /printing press/i,          local: 'مطبعة' },
    { match: /digital printing/i,        local: 'طباعة رقمية' },
    { match: /commercial printing/i,     local: 'طباعة تجارية' },
    { match: /offset printing/i,         local: 'طباعة أوفست' },
    { match: /printing (company|service)/i, local: 'شركة طباعة' },
    { match: /printing/i,                local: 'طباعة' },
    { match: /packaging manufacturer/i,  local: 'مصنع تغليف' },
    { match: /packaging/i,               local: 'تغليف وتعبئة' },
    { match: /label/i,                   local: 'ملصقات وليبل' },
    { match: /signage|sign board|signboard/i, local: 'لافتات وإعلانات' },
    { match: /advertising/i,             local: 'دعاية وإعلان' },
    { match: /stationery/i,              local: 'قرطاسية' },
    { match: /carton|corrugated/i,       local: 'كرتون مموج' },
    { match: /flex/i,                    local: 'طباعة فلكس' },
    { match: /gift/i,                    local: 'هدايا دعائية' },
    { match: /paper/i,                   local: 'ورق ومنتجات ورقية' },
  ],
  tr: [
    { match: /printing press|printing/i, local: 'matbaa' },
    { match: /packaging/i,               local: 'ambalaj' },
    { match: /label/i,                   local: 'etiket' },
    { match: /signage/i,                 local: 'tabela' },
  ],
  ur: [
    { match: /printing press/i,          local: 'پرنٹنگ پریس' },
    { match: /printing/i,                local: 'چھپائی' },
    { match: /packaging/i,               local: 'پیکیجنگ' },
  ],
}

/** Translate an English business keyword into the given local language, or null. */
export function translateKeyword(keyword: string, language: string): string | null {
  const table = KEYWORD_TRANSLATIONS[language]
  if (!table) return null
  for (const entry of table) {
    if (entry.match.test(keyword)) return entry.local
  }
  return null
}

/**
 * Maps capture queries: the English "keyword in city" plus a local-language
 * variant when the country has a non-English primary language and the keyword
 * has a known translation.
 * e.g. OM + "printing press" + "Muscat" →
 *   [ "printing press in Muscat"  (en),
 *     "مطبعة مسقط"                 (ar) ]
 */
export function generateMapsQueries(keyword: string, city: string, countryCode: string): LocalizedQuery[] {
  const intel = getCountryIntelligence(countryCode)
  const queries: LocalizedQuery[] = [
    { query: `${keyword} in ${city}`, language: 'en' },
  ]
  if (intel.localLanguage) {
    const local = translateKeyword(keyword, intel.localLanguage)
    if (local) queries.push({ query: `${local} ${city}`, language: intel.localLanguage })
  }
  return queries
}

/**
 * Evidence search queries for one company: primary quoted English query plus
 * an optional local-language fallback built from the non-Latin part of the
 * company name (used only when the primary search returns too little).
 */
export function generateEvidenceQueries(
  searchName: string,
  originalCompanyName: string,
  city: string,
  countryCode: string,
): { primary: LocalizedQuery; fallback: LocalizedQuery | null } {
  const intel = getCountryIntelligence(countryCode)
  const suffix = intel.querySuffix ? ` ${intel.querySuffix}` : ''

  const primary: LocalizedQuery = {
    query: `"${searchName}" "${city}"${suffix}`,
    language: 'en',
  }

  // Local-language fallback: search the non-Latin portion of the name (an
  // Arabic trade name is often the one local directories actually list).
  let fallback: LocalizedQuery | null = null
  if (intel.localLanguage) {
    const nonLatin = originalCompanyName.replace(/[\x00-\x7F]/g, ' ').replace(/\s+/g, ' ').trim()
    if (nonLatin.length >= 4 && nonLatin !== searchName) {
      fallback = {
        query: `"${nonLatin}" ${city}${suffix}`,
        language: intel.localLanguage,
      }
    }
  }

  return { primary, fallback }
}
