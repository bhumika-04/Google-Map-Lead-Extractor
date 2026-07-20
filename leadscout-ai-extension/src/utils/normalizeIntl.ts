// ── International normalization ──────────────────────────────────────────────
// Deterministic normalizers for extracted facts: legal entity types (Arabic
// suffixes → LLC / SAOC / SAOG), currency amounts (detect code + approx USD),
// and decision-maker titles → a normalized category. Originals are always
// preserved by callers — these return normalized *additions*, never overwrite.

// ── Company legal type ────────────────────────────────────────────────────────

const COMPANY_TYPE_MAP: Array<{ match: RegExp; normalized: string }> = [
  // Arabic entity suffixes
  { match: /ش\.?م\.?ع\.?ع|saog/i,                       normalized: 'SAOG (Public Joint Stock)' },
  { match: /ش\.?م\.?ع\.?م|saoc/i,                       normalized: 'SAOC (Closed Joint Stock)' },
  { match: /ش\.?ذ\.?م\.?م|ذ\.?م\.?م/,                   normalized: 'LLC' },
  { match: /مؤسسة/,                                      normalized: 'Establishment' },
  { match: /شركة تضامن/,                                normalized: 'Partnership' },
  // Gulf Latin suffixes
  { match: /\bw\.?l\.?l\b/i,                             normalized: 'WLL' },
  { match: /\bfz-?(e|c|co|llc)\b/i,                      normalized: 'Free Zone Company' },
  { match: /\bllc\b|limited liability/i,                 normalized: 'LLC' },
  { match: /\bpjsc\b/i,                                  normalized: 'PJSC' },
  { match: /\bbsc\b/i,                                   normalized: 'BSC' },
  // India / UK / global
  { match: /\bpvt\.?\s*ltd\b|private limited/i,          normalized: 'Private Limited' },
  { match: /\bplc\b|public limited/i,                    normalized: 'Public Limited' },
  { match: /\bllp\b/i,                                   normalized: 'LLP' },
  { match: /sole proprietor|proprietorship/i,            normalized: 'Sole Proprietorship' },
  { match: /partnership/i,                               normalized: 'Partnership' },
  { match: /\binc\b|incorporated/i,                      normalized: 'Incorporated' },
]

/** Normalize a company legal type (any language) to a standard label; null when unknown. */
export function normalizeCompanyType(raw: string | undefined): string | null {
  if (!raw) return null
  for (const { match, normalized } of COMPANY_TYPE_MAP) {
    if (match.test(raw)) return normalized
  }
  return null
}

// ── Currency ──────────────────────────────────────────────────────────────────

// Rough static rates for display normalization only — labeled "approx".
const CURRENCY_USD: Record<string, number> = {
  USD: 1, EUR: 1.08, GBP: 1.27,
  INR: 0.012, PKR: 0.0036, BDT: 0.0084, LKR: 0.0033,
  OMR: 2.6, AED: 0.27, SAR: 0.27, QAR: 0.27, KWD: 3.25, BHD: 2.65,
  EGP: 0.021, TRY: 0.03, MYR: 0.21, SGD: 0.74,
  UGX: 0.00027, KES: 0.0078, ZAR: 0.055, NGN: 0.00065,
}

const CURRENCY_SYMBOLS: Array<{ match: RegExp; code: string }> = [
  { match: /₹|\binr\b|rupee|lakh|crore|\bcr\b/i, code: 'INR' },
  { match: /\bomr\b|ر\.ع|omani rial/i,           code: 'OMR' },
  { match: /\baed\b|د\.إ|dirham/i,               code: 'AED' },
  { match: /\bsar\b|ر\.س|saudi riyal/i,          code: 'SAR' },
  { match: /\bqar\b|ر\.ق/i,                      code: 'QAR' },
  { match: /\bkwd\b|د\.ك/i,                      code: 'KWD' },
  { match: /\bbhd\b|د\.ب/i,                      code: 'BHD' },
  { match: /\begp\b|ج\.م/i,                      code: 'EGP' },
  { match: /£|\bgbp\b/i,                          code: 'GBP' },
  { match: /€|\beur\b/i,                          code: 'EUR' },
  { match: /₺|\btry\b/i,                          code: 'TRY' },
  { match: /\bsgd\b/i,                            code: 'SGD' },
  { match: /\bmyr\b|\brm\b/i,                     code: 'MYR' },
  { match: /\bugx\b/i,                            code: 'UGX' },
  { match: /\bkes\b|ksh/i,                        code: 'KES' },
  { match: /\bzar\b|(?<![a-z])r\d/i,              code: 'ZAR' },
  { match: /\$|\busd\b/i,                         code: 'USD' },
]

export interface NormalizedCurrency {
  original: string
  currencyCode: string | null
  /** Approximate USD value — display only, labeled "approx" */
  approxUsd: number | null
}

/** Parse "OMR 200K" / "₹1-10 Cr" / "AED 2M" → currency code + approx USD. */
export function normalizeCurrency(raw: string | undefined): NormalizedCurrency | null {
  if (!raw) return null
  const original = raw.trim()

  let currencyCode: string | null = null
  for (const { match, code } of CURRENCY_SYMBOLS) {
    if (match.test(original)) { currencyCode = code; break }
  }

  // Numeric magnitude: take the first number and its multiplier
  let approxUsd: number | null = null
  const m = original.replace(/,/g, '').match(/([\d.]+)\s*(k|m|b|lakh|lac|cr|crore|million|billion|thousand)?/i)
  if (m && currencyCode) {
    let value = parseFloat(m[1])
    const mult = (m[2] ?? '').toLowerCase()
    if (mult === 'k' || mult === 'thousand') value *= 1e3
    else if (mult === 'm' || mult === 'million') value *= 1e6
    else if (mult === 'b' || mult === 'billion') value *= 1e9
    else if (mult === 'lakh' || mult === 'lac')  value *= 1e5
    else if (mult === 'cr' || mult === 'crore')  value *= 1e7
    const rate = CURRENCY_USD[currencyCode]
    if (rate && !isNaN(value)) approxUsd = Math.round(value * rate)
  }

  return { original, currencyCode, approxUsd }
}

// ── Decision-maker title normalization ───────────────────────────────────────

const ROLE_CATEGORY_MAP: Array<{ match: RegExp; category: string }> = [
  { match: /founder|co-?founder|proprietor|owner|مالك|مؤسس/i,          category: 'Founder/Owner' },
  { match: /managing director|\bmd\b|المدير العام/i,                    category: 'Managing Director' },
  { match: /managing partner|\bpartner\b|شريك/i,                        category: 'Partner' },
  { match: /chief executive|\bceo\b/i,                                  category: 'CEO' },
  { match: /chief (technology|technical)|\bcto\b/i,                     category: 'CTO' },
  { match: /chief operat|\bcoo\b/i,                                     category: 'COO' },
  { match: /chief financ|\bcfo\b/i,                                     category: 'CFO' },
  { match: /general manager|\bgm\b|مدير عام/i,                          category: 'General Manager' },
  { match: /director|مدير/i,                                            category: 'Director' },
  { match: /president/i,                                                category: 'President' },
  { match: /head of|production head|operations head|plant head/i,       category: 'Department Head' },
  { match: /manager/i,                                                  category: 'Manager' },
]

/** Map any decision-maker title (incl. Arabic) to a normalized category. */
export function normalizeRole(title: string | undefined): string | null {
  if (!title) return null
  for (const { match, category } of ROLE_CATEGORY_MAP) {
    if (match.test(title)) return category
  }
  return 'Other'
}
