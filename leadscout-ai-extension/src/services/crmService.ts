// CRM push service — sends lead + research data to your own CRM API.
// Configure CRM URL and auth in Settings → CRM Integration.
// Update buildCrmPayload() when your CRM field schema is defined.

import type { Lead } from '@/types/lead'
import type { ResearchResult } from '@/types/research'
import type { AppSettings } from '@/types/settings'

export interface CrmPushResult {
  ok: boolean
  crmId?: string
  error?: string
}

// Standard payload — update field names here once CRM schema is defined
export function buildCrmPayload(lead: Lead, research?: ResearchResult | null): Record<string, unknown> {
  return {
    company_name:     lead.companyName,
    city:             lead.city,
    phone:            lead.phone ?? null,
    website:          lead.website ?? null,
    address:          lead.address ?? null,
    rating:           lead.rating ?? null,
    category:         lead.category ?? null,
    source:           'LeadScout',
    captured_at:      lead.capturedAt,
    // Research fields — null when research not yet done
    contact_person:   research?.decisionMaker ?? null,
    contact_linkedin: research?.decisionMakerLinkedIn ?? null,
    email:            research?.email ?? null,
    industry:         research?.industry ?? null,
    employee_count:   research?.employeeCount ?? null,
    year_founded:     research?.yearFounded ?? null,
    annual_turnover:  research?.annualTurnover ?? null,
    linkedin:         research?.linkedIn ?? null,
    summary:          research?.summary ?? null,
    confidence:       research?.confidence ?? null,
  }
}

export async function pushLeadToCrm(
  lead: Lead,
  settings: AppSettings,
  research?: ResearchResult | null,
): Promise<CrmPushResult> {
  const { crmApiUrl, crmApiKey, crmAuthType } = settings

  if (!crmApiUrl) return { ok: false, error: 'CRM API URL not configured — go to Settings → CRM Integration' }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (crmAuthType === 'bearer'  && crmApiKey) headers['Authorization'] = `Bearer ${crmApiKey}`
  if (crmAuthType === 'api_key' && crmApiKey) headers['X-Api-Key'] = crmApiKey

  try {
    const res = await fetch(crmApiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildCrmPayload(lead, research)),
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, error: `CRM ${res.status}: ${text.slice(0, 200)}` }
    }

    const data = await res.json().catch(() => ({}))
    return { ok: true, crmId: data?.id ?? data?.lead_id ?? undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Network error' }
  }
}

export async function pushBatchToCrm(
  leads: Lead[],
  settings: AppSettings,
): Promise<{ pushed: number; failed: number; errors: string[] }> {
  let pushed = 0
  let failed = 0
  const errors: string[] = []

  for (const lead of leads) {
    const result = await pushLeadToCrm(lead, settings)
    if (result.ok) {
      pushed++
    } else {
      failed++
      if (result.error) errors.push(`${lead.companyName}: ${result.error}`)
    }
  }

  return { pushed, failed, errors }
}
