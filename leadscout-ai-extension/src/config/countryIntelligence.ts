// ── Country Intelligence Layer ────────────────────────────────────────────────
// Per-country configuration for the international pipeline: languages, Google
// region, local domains, currency, corporate registries, directories, and
// localized search templates. Every stage of the pipeline (Maps capture,
// evidence search, link classification, extraction normalization) reads from
// this single source of truth instead of scattering country logic everywhere.

export interface CountryIntelligence {
  countryCode: string
  countryName: string
  /** Languages business content appears in, primary first */
  primaryLanguages: string[]
  /** ISO 639-1 code of the main local (non-English) language, if any */
  localLanguage?: string
  /** Google `gl=` region parameter */
  googleRegion: string
  /** Country-specific Google domain (falls back to google.com) */
  googleDomain: string
  /** Local ccTLDs — a result on one of these gets a locality ranking bonus */
  localDomains: string[]
  currency: string
  /** Approx USD per 1 unit of local currency — for display normalization only */
  currencyToUsd: number
  /** Domains of country business directories → classified company_directory */
  companyDirectories: string[]
  /** Domains of official corporate registries → classified corporate_registry */
  businessRegistrySources: string[]
  /** Query suffix appended to evidence searches (usually the country name) */
  querySuffix: string
  /** Registry description used inside AI enrichment prompts */
  registryPromptHint: string
  /** How turnover is usually quoted, used inside AI prompts */
  currencyNote: string
  /** Label of the primary company registration ID */
  regIdLabel: string
}

const DEFAULTS: Omit<CountryIntelligence, 'countryCode' | 'countryName'> = {
  primaryLanguages: ['English'],
  googleRegion: 'us',
  googleDomain: 'google.com',
  localDomains: [],
  currency: 'USD',
  currencyToUsd: 1,
  companyDirectories: [],
  businessRegistrySources: ['opencorporates.com'],
  querySuffix: '',
  registryPromptHint: 'the official company registry, chamber of commerce, LinkedIn, Yellow Pages, Kompass, and any local business directory',
  currencyNote: 'local currency',
  regIdLabel: 'company registration / license number',
}

export const COUNTRY_INTELLIGENCE: Record<string, CountryIntelligence> = {
  IN: {
    ...DEFAULTS,
    countryCode: 'IN', countryName: 'India',
    primaryLanguages: ['English', 'Hindi'],
    googleRegion: 'in', googleDomain: 'google.co.in',
    localDomains: ['.in', '.co.in'],
    currency: 'INR', currencyToUsd: 0.012,
    companyDirectories: ['justdial.com', 'sulekha.com', 'indiamart.com', 'tradeindia.com', 'exportersindia.com'],
    businessRegistrySources: ['mca.gov.in', 'zaubacorp.com', 'zauba.com', 'tofler.in', 'opencorporates.com'],
    querySuffix: '',
    registryPromptHint: 'MCA, IndiaMART, Tofler, Zauba, JustDial, TradeIndia, and any Indian company directory',
    currencyNote: 'INR (₹) e.g. "₹40 Lakh", "₹1-10 Cr"',
    regIdLabel: 'CIN (21-char MCA Corporate Identification Number)',
  },
  OM: {
    ...DEFAULTS,
    countryCode: 'OM', countryName: 'Oman',
    primaryLanguages: ['Arabic', 'English'], localLanguage: 'ar',
    googleRegion: 'om', googleDomain: 'google.com.om',
    localDomains: ['.om', '.com.om'],
    currency: 'OMR', currencyToUsd: 2.6,
    companyDirectories: ['omanpages.com', 'businesslist.com.om', 'omanet.om', 'gulfleads.ae', 'yellowpages-ar.cybo.com'],
    businessRegistrySources: ['business.gov.om', 'mocioman.gov.om', 'chamberoman.om', 'opencorporates.com'],
    querySuffix: 'Oman',
    registryPromptHint: 'Oman Chamber of Commerce, Ministry of Commerce Oman (business.gov.om), Yellow Pages Oman, GulfLeads, and any Oman business directory',
    currencyNote: 'OMR e.g. "OMR 50K", "OMR 200K"',
    regIdLabel: 'CR Number (Oman Commercial Registration)',
  },
  AE: {
    ...DEFAULTS,
    countryCode: 'AE', countryName: 'UAE',
    primaryLanguages: ['Arabic', 'English'], localLanguage: 'ar',
    googleRegion: 'ae', googleDomain: 'google.ae',
    localDomains: ['.ae'],
    currency: 'AED', currencyToUsd: 0.27,
    companyDirectories: ['yellowpages.ae', 'dubizzle.com', 'companiesintheuae.com', 'gulfleads.ae'],
    businessRegistrySources: ['ded.ae', 'u.ae', 'dubaichamber.com', 'opencorporates.com'],
    querySuffix: 'UAE',
    registryPromptHint: 'DED Dubai, Abu Dhabi Chamber, Dubai Chamber of Commerce, Yellow Pages UAE, Kompass Middle East, and any UAE business directory',
    currencyNote: 'AED e.g. "AED 500K", "AED 2M"',
    regIdLabel: 'Trade License Number or DED License Number',
  },
  SA: {
    ...DEFAULTS,
    countryCode: 'SA', countryName: 'Saudi Arabia',
    primaryLanguages: ['Arabic', 'English'], localLanguage: 'ar',
    googleRegion: 'sa', googleDomain: 'google.com.sa',
    localDomains: ['.sa', '.com.sa'],
    currency: 'SAR', currencyToUsd: 0.27,
    companyDirectories: ['yellowpages.com.sa', 'saudibusiness.com'],
    businessRegistrySources: ['mc.gov.sa', 'saudibusinesscenter.sa', 'opencorporates.com'],
    querySuffix: 'Saudi Arabia',
    registryPromptHint: 'Saudi Chamber of Commerce, CR (Commercial Registration) lookup, Yellow Pages KSA, Kompass, and any Saudi business directory',
    currencyNote: 'SAR e.g. "SAR 1M", "SAR 5M"',
    regIdLabel: 'CR Number (Commercial Registration Number)',
  },
  QA: {
    ...DEFAULTS,
    countryCode: 'QA', countryName: 'Qatar',
    primaryLanguages: ['Arabic', 'English'], localLanguage: 'ar',
    googleRegion: 'qa', googleDomain: 'google.com.qa',
    localDomains: ['.qa', '.com.qa'],
    currency: 'QAR', currencyToUsd: 0.27,
    companyDirectories: ['qataryellowpages.com'],
    businessRegistrySources: ['moci.gov.qa', 'qatarchamber.com', 'opencorporates.com'],
    querySuffix: 'Qatar',
    registryPromptHint: 'Qatar Chamber of Commerce, Ministry of Commerce Qatar, Yellow Pages Qatar, and any Qatar business directory',
    currencyNote: 'QAR e.g. "QAR 500K", "QAR 2M"',
    regIdLabel: 'QR (Qatar Commercial Registration Number)',
  },
  KW: {
    ...DEFAULTS,
    countryCode: 'KW', countryName: 'Kuwait',
    primaryLanguages: ['Arabic', 'English'], localLanguage: 'ar',
    googleRegion: 'kw', googleDomain: 'google.com.kw',
    localDomains: ['.kw', '.com.kw'],
    currency: 'KWD', currencyToUsd: 3.25,
    companyDirectories: ['yellowpages.com.kw'],
    businessRegistrySources: ['moci.gov.kw', 'opencorporates.com'],
    querySuffix: 'Kuwait',
    registryPromptHint: 'Kuwait Chamber of Commerce, Ministry of Commerce Kuwait, Yellow Pages Kuwait, and any Kuwait business directory',
    currencyNote: 'KWD e.g. "KWD 100K", "KWD 500K"',
    regIdLabel: 'Commercial License Number',
  },
  BH: {
    ...DEFAULTS,
    countryCode: 'BH', countryName: 'Bahrain',
    primaryLanguages: ['Arabic', 'English'], localLanguage: 'ar',
    googleRegion: 'bh', googleDomain: 'google.com.bh',
    localDomains: ['.bh', '.com.bh'],
    currency: 'BHD', currencyToUsd: 2.65,
    companyDirectories: ['bahrainyellowpages.com'],
    businessRegistrySources: ['sijilat.bh', 'moic.gov.bh', 'opencorporates.com'],
    querySuffix: 'Bahrain',
    registryPromptHint: 'Bahrain Chamber of Commerce, Sijilat (Bahrain business registry), Yellow Pages Bahrain, and any Bahrain business directory',
    currencyNote: 'BHD e.g. "BHD 100K", "BHD 500K"',
    regIdLabel: 'CR Number (Bahrain Commercial Registration)',
  },
  EG: {
    ...DEFAULTS,
    countryCode: 'EG', countryName: 'Egypt',
    primaryLanguages: ['Arabic', 'English'], localLanguage: 'ar',
    googleRegion: 'eg', googleDomain: 'google.com.eg',
    localDomains: ['.eg', '.com.eg'],
    currency: 'EGP', currencyToUsd: 0.021,
    companyDirectories: ['yellowpages.com.eg'],
    businessRegistrySources: ['gafi.gov.eg', 'opencorporates.com'],
    querySuffix: 'Egypt',
    registryPromptHint: 'GAFI, Egyptian Chamber of Commerce, Yellow Pages Egypt, and any Egyptian business directory',
    currencyNote: 'EGP e.g. "EGP 1M", "EGP 10M"',
    regIdLabel: 'Commercial Registration Number',
  },
  PK: {
    ...DEFAULTS,
    countryCode: 'PK', countryName: 'Pakistan',
    primaryLanguages: ['Urdu', 'English'], localLanguage: 'ur',
    googleRegion: 'pk', googleDomain: 'google.com.pk',
    localDomains: ['.pk', '.com.pk'],
    currency: 'PKR', currencyToUsd: 0.0036,
    companyDirectories: ['pakbiz.com', 'businesslist.pk'],
    businessRegistrySources: ['secp.gov.pk', 'opencorporates.com'],
    querySuffix: 'Pakistan',
    registryPromptHint: 'SECP, Pakistan Chamber of Commerce, PakBiz, and any Pakistani business directory',
    currencyNote: 'PKR e.g. "PKR 10M", "PKR 100M"',
    regIdLabel: 'SECP Incorporation Number',
  },
  GB: {
    ...DEFAULTS,
    countryCode: 'GB', countryName: 'United Kingdom',
    googleRegion: 'uk', googleDomain: 'google.co.uk',
    localDomains: ['.uk', '.co.uk'],
    currency: 'GBP', currencyToUsd: 1.27,
    companyDirectories: ['yell.com', 'cylex-uk.co.uk'],
    businessRegistrySources: ['companieshouse.gov.uk', 'endole.co.uk', 'opencorporates.com'],
    querySuffix: 'UK',
    registryPromptHint: 'Companies House, Endole, Yell, Kompass, and any UK business directory',
    currencyNote: 'GBP e.g. "£500K", "£2M"',
    regIdLabel: 'Companies House Number',
  },
  SG: {
    ...DEFAULTS,
    countryCode: 'SG', countryName: 'Singapore',
    googleRegion: 'sg', googleDomain: 'google.com.sg',
    localDomains: ['.sg', '.com.sg'],
    currency: 'SGD', currencyToUsd: 0.74,
    companyDirectories: ['sgpbusiness.com', 'businessdirectory.com.sg'],
    businessRegistrySources: ['acra.gov.sg', 'sgpbusiness.com', 'opencorporates.com'],
    querySuffix: 'Singapore',
    registryPromptHint: 'ACRA, SGPBusiness, Singapore business directories',
    currencyNote: 'SGD e.g. "SGD 500K", "SGD 2M"',
    regIdLabel: 'ACRA UEN',
  },
  UG: {
    ...DEFAULTS,
    countryCode: 'UG', countryName: 'Uganda',
    googleRegion: 'ug', googleDomain: 'google.co.ug',
    localDomains: ['.ug', '.co.ug'],
    currency: 'UGX', currencyToUsd: 0.00027,
    companyDirectories: ['yellowpages-uganda.com', 'businesslist.co.ug'],
    businessRegistrySources: ['ursb.go.ug', 'opencorporates.com'],
    querySuffix: 'Uganda',
    registryPromptHint: 'URSB (Uganda Registration Services Bureau), Uganda business directories',
    currencyNote: 'UGX e.g. "UGX 100M"',
    regIdLabel: 'URSB Registration Number',
  },
  KE: {
    ...DEFAULTS,
    countryCode: 'KE', countryName: 'Kenya',
    googleRegion: 'ke', googleDomain: 'google.co.ke',
    localDomains: ['.ke', '.co.ke'],
    currency: 'KES', currencyToUsd: 0.0078,
    companyDirectories: ['businesslist.co.ke', 'yellowpageskenya.com'],
    businessRegistrySources: ['brs.go.ke', 'opencorporates.com'],
    querySuffix: 'Kenya',
    registryPromptHint: 'BRS Kenya, Kenya business directories',
    currencyNote: 'KES e.g. "KES 10M"',
    regIdLabel: 'BRS Registration Number',
  },
  ZA: {
    ...DEFAULTS,
    countryCode: 'ZA', countryName: 'South Africa',
    googleRegion: 'za', googleDomain: 'google.co.za',
    localDomains: ['.za', '.co.za'],
    currency: 'ZAR', currencyToUsd: 0.055,
    companyDirectories: ['yellowpages.co.za', 'brabys.com'],
    businessRegistrySources: ['cipc.co.za', 'opencorporates.com'],
    querySuffix: 'South Africa',
    registryPromptHint: 'CIPC, South African business directories',
    currencyNote: 'ZAR e.g. "R5M", "R20M"',
    regIdLabel: 'CIPC Registration Number',
  },
  TR: {
    ...DEFAULTS,
    countryCode: 'TR', countryName: 'Turkey',
    primaryLanguages: ['Turkish', 'English'], localLanguage: 'tr',
    googleRegion: 'tr', googleDomain: 'google.com.tr',
    localDomains: ['.tr', '.com.tr'],
    currency: 'TRY', currencyToUsd: 0.03,
    companyDirectories: ['firmalar.com.tr'],
    businessRegistrySources: ['ticaretsicil.gov.tr', 'opencorporates.com'],
    querySuffix: 'Turkey',
    registryPromptHint: 'Turkish Trade Registry, Turkish Chamber of Commerce, Turkish business directories',
    currencyNote: 'TRY e.g. "₺1M", "₺10M"',
    regIdLabel: 'Trade Registry Number',
  },
  MY: {
    ...DEFAULTS,
    countryCode: 'MY', countryName: 'Malaysia',
    primaryLanguages: ['Malay', 'English'], localLanguage: 'ms',
    googleRegion: 'my', googleDomain: 'google.com.my',
    localDomains: ['.my', '.com.my'],
    currency: 'MYR', currencyToUsd: 0.21,
    companyDirectories: ['yellowpages.my'],
    businessRegistrySources: ['ssm.com.my', 'opencorporates.com'],
    querySuffix: 'Malaysia',
    registryPromptHint: 'SSM (Companies Commission of Malaysia), Malaysian business directories',
    currencyNote: 'MYR e.g. "RM500K", "RM2M"',
    regIdLabel: 'SSM Registration Number',
  },
  BD: {
    ...DEFAULTS,
    countryCode: 'BD', countryName: 'Bangladesh',
    primaryLanguages: ['Bengali', 'English'], localLanguage: 'bn',
    googleRegion: 'bd', googleDomain: 'google.com.bd',
    localDomains: ['.bd', '.com.bd'],
    currency: 'BDT', currencyToUsd: 0.0084,
    companyDirectories: ['businesslist.com.bd'],
    businessRegistrySources: ['roc.gov.bd', 'opencorporates.com'],
    querySuffix: 'Bangladesh',
    registryPromptHint: 'RJSC Bangladesh, Bangladeshi business directories',
    currencyNote: 'BDT e.g. "৳10M"',
    regIdLabel: 'RJSC Registration Number',
  },
  US: {
    ...DEFAULTS,
    countryCode: 'US', countryName: 'United States',
    googleRegion: 'us', googleDomain: 'google.com',
    localDomains: [],
    currency: 'USD', currencyToUsd: 1,
    companyDirectories: ['manta.com', 'bbb.org'],
    businessRegistrySources: ['opencorporates.com', 'dnb.com'],
    querySuffix: 'USA',
    registryPromptHint: 'state corporate registries, D&B, BBB, and US business directories',
    currencyNote: 'USD e.g. "$500K", "$2M"',
    regIdLabel: 'State Registration / EIN',
  },
}

/** Returns the country config, falling back to sensible defaults for unknown codes. */
export function getCountryIntelligence(countryCode: string): CountryIntelligence {
  const code = (countryCode || 'IN').toUpperCase()
  return COUNTRY_INTELLIGENCE[code] ?? {
    ...DEFAULTS,
    countryCode: code,
    countryName: code,
    googleRegion: code.toLowerCase(),
    querySuffix: '',
  }
}
