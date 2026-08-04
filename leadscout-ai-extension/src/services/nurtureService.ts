// Nurture service — manages message templates and scheduled sequences in MSSQL.
// Templates define the message body + timing. Sequences schedule a template for a specific company.

import { API_BASE as API } from '@/config/api'

export interface NurtureTemplate {
  id: string
  name: string
  channel: string
  stage: string
  sequenceStep: number
  delayDays: number
  subject?: string
  messageTemplate: string
  createdAt: string
}

export interface NurtureSequenceItem {
  id: string
  companyId: string
  companyName: string
  city?: string
  phone?: string
  contactName?: string
  channel: string
  templateName: string
  messageTemplate: string
  subject?: string
  scheduledFor: string
  status: 'pending' | 'sent' | 'skipped'
}

// Intentionally throws on fetch failure so NurturePanel can detect "API is down"
// and show the error state. Contrast with getDueSequences/getAllScheduledSequences
// below which silently return [] — those are called from the service worker alarm
// where a crash would be unrecoverable, so silent failure is safer there.
export async function getTemplates(): Promise<NurtureTemplate[]> {
  const res = await fetch(`${API}/api/nurture/templates`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.templates ?? []
}

export async function createTemplate(t: Omit<NurtureTemplate, 'id' | 'createdAt'>): Promise<{ ok: boolean; id?: string }> {
  try {
    const res = await fetch(`${API}/api/nurture/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(t),
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json()
    return { ok: data.ok, id: data.id }
  } catch {
    return { ok: false }
  }
}

export async function updateTemplate(id: string, t: Partial<NurtureTemplate>): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`${API}/api/nurture/templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(t),
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json()
    return { ok: data.ok }
  } catch {
    return { ok: false }
  }
}

export async function deleteTemplate(id: string): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`${API}/api/nurture/templates/${id}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json()
    return { ok: data.ok }
  } catch {
    return { ok: false }
  }
}

export async function scheduleSequence(opts: {
  companyId: string
  templateId: string
  channel: string
  delayDays: number
}): Promise<{ ok: boolean }> {
  const scheduledFor = new Date()
  scheduledFor.setDate(scheduledFor.getDate() + opts.delayDays)
  try {
    const res = await fetch(`${API}/api/nurture/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...opts, scheduledFor: scheduledFor.toISOString() }),
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json()
    return { ok: data.ok }
  } catch {
    return { ok: false }
  }
}

// Silent [] on error — called from the hourly service worker alarm where a thrown
// error would crash the alarm handler and prevent future nurture checks.
export async function getDueSequences(): Promise<NurtureSequenceItem[]> {
  try {
    const res = await fetch(`${API}/api/nurture/due`, { signal: AbortSignal.timeout(5000) })
    const data = await res.json()
    return data.sequences ?? []
  } catch {
    return []
  }
}

// Silent [] on error — same rationale as getDueSequences.
export async function getAllScheduledSequences(): Promise<NurtureSequenceItem[]> {
  try {
    const res = await fetch(`${API}/api/nurture/scheduled`, { signal: AbortSignal.timeout(5000) })
    const data = await res.json()
    return data.sequences ?? []
  } catch {
    return []
  }
}

export async function markSequenceSent(id: string): Promise<void> {
  try {
    await fetch(`${API}/api/nurture/complete/${id}`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    })
  } catch {}
}

export async function skipSequence(id: string): Promise<void> {
  try {
    await fetch(`${API}/api/nurture/skip/${id}`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    })
  } catch {}
}
