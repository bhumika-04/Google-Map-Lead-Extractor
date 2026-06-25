import React, { useState, useEffect, useCallback } from 'react'
import type { Lead, LeadStatus } from '@/types/lead'
import { useLeadStore } from '@/state/useLeadStore'
import { activityLogRepository } from '@/db/activityLogRepository'
import { addToResearchQueue } from '@/services/futureResearchService'
import { toast } from '@/state/useToastStore'
import { formatDateTime } from '@/utils/date'
import { calculateLeadScore, scoreLabel, scoreColor } from '@/utils/leadScore'
import { leadRepository } from '@/db/leadRepository'
import StatusBadge from './StatusBadge'
import CopyBtn from './CopyBtn'
import ResearchResultCard from './ResearchResultCard'

function buildOutreachEmail(lead: Lead): string {
  return `Subject: Quick question about ${lead.companyName}

Hi ${lead.companyName} team,

I came across your business while searching for ${lead.keyword} services in ${lead.city} and wanted to reach out.

[Your personalised message here]

Would love to connect — feel free to reply to this email${lead.phone ? ` or call us at ${lead.phone}` : ''}.

Best regards,
[Your Name]
[Your Company]`
}

const STATUS_OPTIONS: { value: LeadStatus; label: string; color: string }[] = [
  { value: 'new',               label: 'New',               color: 'bg-blue-600' },
  { value: 'selected',          label: 'Interested',        color: 'bg-green-600' },
  { value: 'rejected',          label: 'Not Relevant',      color: 'bg-red-700' },
  { value: 'research_pending',  label: 'Research Pending',  color: 'bg-purple-600' },
]

export default function LeadDetailPanel() {
  const { detailLead, closeDetail, updateLeadStatus, updateLeadNotes, updateLeadTags, deleteLead } = useLeadStore()
  const [notes, setNotes] = useState('')
  const [notesDirty, setNotesDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [tagInput, setTagInput] = useState('')

  useEffect(() => {
    if (detailLead) {
      setNotes(detailLead.notes ?? '')
      setNotesDirty(false)
      setTagInput('')
    }
  }, [detailLead?.id])

  // Auto-refresh the lead from DB while research is in-progress so results
  // appear without requiring the user to close and re-open the panel.
  useEffect(() => {
    if (!detailLead?.id) return
    const inProgress = detailLead.status === 'research_pending' || detailLead.status === 'research_running'
    if (!inProgress) return
    const iv = setInterval(async () => {
      const fresh = await leadRepository.getById(detailLead.id!).catch(() => null)
      if (!fresh) return
      // Push fresh status into the store so the panel re-renders
      if (fresh.status !== detailLead.status) {
        useLeadStore.setState((s) => ({
          detailLead: s.detailLead?.id === fresh.id ? { ...s.detailLead, ...fresh } : s.detailLead,
          leads: s.leads.map((l) => l.id === fresh.id ? { ...l, ...fresh } : l),
        }))
      }
    }, 3000)
    return () => clearInterval(iv)
  }, [detailLead?.id, detailLead?.status])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') closeDetail()
  }, [closeDetail])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  async function handleStatusChange(status: LeadStatus) {
    if (!detailLead?.id) return
    await updateLeadStatus(detailLead.id, status)
    await activityLogRepository.log(
      status === 'selected' ? 'lead_selected' : status === 'rejected' ? 'lead_rejected' : 'lead_updated',
      `${detailLead.companyName} → ${status}`, detailLead.sessionId
    )
    toast.success(`Status updated to ${status}`)
  }

  async function handleSaveNotes() {
    if (!detailLead?.id) return
    setSaving(true)
    await updateLeadNotes(detailLead.id, notes)
    setSaving(false)
    setNotesDirty(false)
    toast.success('Notes saved')
  }

  async function handleDelete() {
    if (!detailLead?.id) return
    if (!confirm(`Delete "${detailLead.companyName}"?`)) return
    await deleteLead(detailLead.id)
    toast.info(`${detailLead.companyName} deleted`)
    closeDetail()
  }

  if (!detailLead) return null

  const lead   = detailLead
  const score  = calculateLeadScore(lead)
  const sColor = scoreColor(score)
  const sLabel = scoreLabel(score)

  async function handleCopyOutreach() {
    await navigator.clipboard.writeText(buildOutreachEmail(lead))
    toast.success('Outreach email template copied to clipboard')
  }

  return (
    <div className="w-96 shrink-0 bg-gray-900 border-l border-gray-800
      flex flex-col overflow-hidden h-full">

        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <div className="flex-1 min-w-0 pr-3">
            <h2 className="text-sm font-bold text-white leading-tight truncate" title={lead.companyName}>
              {lead.companyName}
            </h2>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {lead.category && <p className="text-xs text-gray-400">{lead.category}</p>}
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-xs font-semibold ${sColor}`}>
                {score} <span className="font-normal opacity-75">{sLabel}</span>
              </span>
            </div>
          </div>
          <button
            onClick={closeDetail}
            className="text-gray-500 hover:text-white text-lg leading-none transition-colors shrink-0 mt-0.5"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

          {/* Status */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Status</span>
              <StatusBadge status={lead.status} size="xs" />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {STATUS_OPTIONS.map(({ value, label, color }) => (
                <button
                  key={value}
                  onClick={() => handleStatusChange(value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border
                    ${lead.status === value
                      ? `${color} text-white border-transparent`
                      : 'bg-gray-800 text-gray-400 border-gray-700 hover:border-gray-500 hover:text-white'
                    }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          {/* Rating */}
          {(lead.rating != null || lead.reviewCount != null) && (
            <section>
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Rating</div>
              <div className="flex items-center gap-3">
                {lead.rating != null && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-yellow-400 text-lg font-bold">{lead.rating}</span>
                    <span className="text-yellow-400">★</span>
                  </div>
                )}
                {lead.reviewCount != null && (
                  <span className="text-gray-500 text-xs">{Number(lead.reviewCount).toLocaleString()} reviews</span>
                )}
              </div>
            </section>
          )}

          {/* Contact info */}
          <section className="space-y-2.5">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Contact</div>

            {lead.phone ? (
              <div className="flex items-center justify-between gap-2 bg-gray-800 rounded-lg px-3 py-2.5">
                <div>
                  <div className="text-xs text-gray-500 mb-0.5">Phone</div>
                  <div className="text-sm text-white font-medium">{lead.phone}</div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <CopyBtn value={lead.phone} label="Copy" />
                  <a
                    href={`tel:${lead.phone}`}
                    className="px-1.5 py-0.5 bg-gray-700 hover:bg-blue-700 text-gray-400 hover:text-white rounded text-xs transition-colors"
                    title="Call"
                    onClick={(e) => e.stopPropagation()}
                  >
                    ☏
                  </a>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 bg-gray-800/50 rounded-lg px-3 py-2.5 text-gray-600 text-xs">
                Phone not captured
              </div>
            )}

            {lead.website ? (
              <div className="flex items-center justify-between gap-2 bg-gray-800 rounded-lg px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-gray-500 mb-0.5">Website</div>
                  <a
                    href={lead.website}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-blue-400 hover:text-blue-300 hover:underline truncate block transition-colors"
                    title={lead.website}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {lead.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                  </a>
                </div>
                <CopyBtn value={lead.website} label="Copy" className="shrink-0" />
              </div>
            ) : (
              <div className="flex items-center gap-2 bg-gray-800/50 rounded-lg px-3 py-2.5 text-gray-600 text-xs">
                Website not captured
              </div>
            )}

            {lead.address && (
              <div className="flex items-start justify-between gap-2 bg-gray-800 rounded-lg px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-gray-500 mb-0.5">Address</div>
                  <div className="text-sm text-gray-200 leading-snug">{lead.address}</div>
                </div>
                <CopyBtn value={lead.address} className="shrink-0 mt-0.5" />
              </div>
            )}
          </section>

          {/* Search metadata */}
          <section className="space-y-2">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Search Info</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <InfoCell label="City" value={lead.city} />
              <InfoCell label="Keyword" value={lead.keyword} />
              <InfoCell label="Confidence" value={`${Math.round(lead.confidence * 100)}%`} />
              <InfoCell label="Source" value="Google Maps" />
            </div>
          </section>

          {/* Google Maps link */}
          {lead.googleMapsUrl && (
            <a
              href={lead.googleMapsUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 px-3 py-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-xs
                text-gray-300 hover:text-white transition-colors border border-gray-700 hover:border-gray-600"
              onClick={(e) => e.stopPropagation()}
            >
              <span>⌖</span>
              <span>View on Google Maps</span>
              <span className="ml-auto text-gray-600">↗</span>
            </a>
          )}

          {/* Notes */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Notes</div>
              {notesDirty && (
                <button
                  onClick={handleSaveNotes}
                  disabled={saving}
                  className="text-xs px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded-lg
                    transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              )}
            </div>
            <textarea
              value={notes}
              onChange={(e) => { setNotes(e.target.value); setNotesDirty(true) }}
              onKeyDown={(e) => { if (e.key === 'Escape') e.stopPropagation() }}
              placeholder="Add notes, follow-up reminders, or contact details…"
              rows={4}
              className="w-full bg-gray-800 border border-gray-700 text-white text-xs px-3 py-2.5 rounded-lg
                placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500
                resize-none transition-colors leading-relaxed"
            />
          </section>

          {/* Research Results (Phase 2) */}
          {lead.id && (lead.status === 'research_completed' || lead.status === 'research_failed') && (
            <ResearchResultCard leadId={lead.id} />
          )}
          {lead.status === 'research_pending' && (
            <section className="bg-purple-950/40 border border-purple-800/50 rounded-xl p-3 text-xs text-purple-300 animate-pulse">
              <div className="font-medium mb-0.5">⚗ Research in progress…</div>
              <div className="text-purple-500">AI is fetching website and extracting contacts. This panel will update automatically.</div>
            </section>
          )}
          {lead.status === 'research_failed' && (
            <section className="bg-red-950/40 border border-red-800/50 rounded-xl p-3 space-y-2 mt-2">
              <div className="text-xs font-medium text-red-400">Research failed</div>
              <div className="text-xs text-red-600">Check your API key in Settings and retry.</div>
              <button
                onClick={async () => {
                  if (!lead.id) return
                  await addToResearchQueue(lead)
                  toast.success('Re-queued for research')
                }}
                className="text-xs px-3 py-1.5 bg-purple-800 hover:bg-purple-700 text-white rounded-lg transition-colors"
              >
                ⚗ Retry Research
              </button>
            </section>
          )}
          {lead.id && !['research_pending','research_completed','research_failed'].includes(lead.status) && (
            <section>
              <button
                onClick={async () => {
                  await addToResearchQueue(lead)
                  toast.success('Queued for AI research')
                }}
                className="w-full text-xs px-3 py-2.5 bg-purple-900/40 hover:bg-purple-800/60 border border-purple-800/50 hover:border-purple-700
                  text-purple-300 hover:text-white rounded-xl transition-colors text-left"
              >
                <span className="font-medium">⚗ Research this lead</span>
                <span className="block text-purple-500 mt-0.5">Use AI to find decision maker, email, services & more</span>
              </button>
            </section>
          )}

          {/* Tags */}
          <section>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Tags</div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {(lead.tags ?? []).map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs
                    bg-blue-950 border border-blue-800 text-blue-300"
                >
                  {tag}
                  <button
                    onClick={async () => {
                      const next = (lead.tags ?? []).filter((t) => t !== tag)
                      await updateLeadTags(lead.id!, next)
                    }}
                    className="text-blue-500 hover:text-white leading-none transition-colors"
                    title="Remove tag"
                  >
                    ×
                  </button>
                </span>
              ))}
              {(lead.tags ?? []).length === 0 && (
                <span className="text-xs text-gray-700">No tags yet</span>
              )}
            </div>
            <div className="flex gap-2">
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === 'Escape') { e.stopPropagation(); setTagInput(''); return }
                  if (e.key !== 'Enter') return
                  const t = tagInput.trim()
                  if (!t || (lead.tags ?? []).includes(t)) { setTagInput(''); return }
                  await updateLeadTags(lead.id!, [...(lead.tags ?? []), t])
                  setTagInput('')
                }}
                placeholder="Add tag (Enter to save)"
                className="flex-1 bg-gray-800 border border-gray-700 text-white text-xs px-3 py-1.5
                  rounded-lg placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>
          </section>

          {/* Timestamps */}
          <section className="text-xs text-gray-600 space-y-1 pb-2">
            <div>Captured: <span className="text-gray-500">{formatDateTime(lead.capturedAt)}</span></div>
            <div>Updated: <span className="text-gray-500">{formatDateTime(lead.updatedAt)}</span></div>
          </section>
        </div>

        {/* Footer actions */}
        <div className="px-5 py-3 border-t border-gray-800 flex flex-wrap gap-2 shrink-0">
          {notesDirty && (
            <button
              onClick={handleSaveNotes}
              disabled={saving}
              className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold
                rounded-lg transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save Notes'}
            </button>
          )}
          <button
            onClick={handleCopyOutreach}
            className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 hover:bg-purple-950
              text-gray-400 hover:text-purple-300 text-xs rounded-lg transition-colors border border-gray-700
              hover:border-purple-800"
            title="Copy a pre-filled outreach email template"
          >
            ✉ Outreach
          </button>
          <button
            onClick={handleDelete}
            className="px-3 py-2 bg-gray-800 hover:bg-red-950 text-gray-500 hover:text-red-400
              text-xs rounded-lg transition-colors border border-gray-700 hover:border-red-900"
          >
            Delete
          </button>
          <button
            onClick={closeDetail}
            className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white
              text-xs rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
    </div>
  )
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-800 rounded-lg px-3 py-2">
      <div className="text-gray-600 mb-0.5">{label}</div>
      <div className="text-gray-200 font-medium truncate">{value}</div>
    </div>
  )
}
