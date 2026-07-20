import React, { useEffect, useState, useCallback } from 'react'
import type { Lead } from '@/types/lead'
import type { LinkedInScraperJob } from '@/types/linkedinData'
import { leadRepository } from '@/db/leadRepository'
import { companyResearchRepository } from '@/db/companyResearchRepository'
import { fetchLinkedInIntelligence, type LinkedInIntelligence } from '@/services/sqlSyncService'
import { MSG } from '@/types/messages'
import { toast } from '@/state/useToastStore'

interface LiLead extends Lead {
  linkedinUrl: string
}

export default function LinkedInIntelligencePage() {
  const [leads, setLeads] = useState<LiLead[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<LiLead | null>(null)
  const [intel, setIntel] = useState<LinkedInIntelligence | null>(null)
  const [intelLoading, setIntelLoading] = useState(false)
  const [job, setJob] = useState<LinkedInScraperJob | null>(null)

  const load = useCallback(async () => {
    const all = await leadRepository.getAll()
    const withLinkedIn: LiLead[] = []
    for (const lead of all) {
      if (!lead.id) continue
      const research = await companyResearchRepository.getByLeadId(lead.id)
      if (research?.linkedinUrl) withLinkedIn.push({ ...lead, linkedinUrl: research.linkedinUrl })
    }
    setLeads(withLinkedIn)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const loadIntel = useCallback(async (lead: LiLead) => {
    if (!lead.mssqlId) { setIntel(null); return }
    setIntelLoading(true)
    const data = await fetchLinkedInIntelligence(lead.mssqlId)
    setIntel(data)
    setIntelLoading(false)
  }, [])

  useEffect(() => {
    if (selected) loadIntel(selected)
    else setIntel(null)
  }, [selected, loadIntel])

  // Poll the active scraper job while it's running for the selected lead
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    const poll = async () => {
      const res = await chrome.runtime.sendMessage({ type: MSG.LI_SCRAPER_STATUS }).catch(() => null)
      if (cancelled) return
      const j = res?.job as LinkedInScraperJob | null | undefined
      if (j && j.leadId === selected.id) {
        setJob(j)
        if (j.status === 'done') { loadIntel(selected) }
      } else if (!j || j.leadId !== selected.id) {
        setJob((prev) => (prev?.leadId === selected.id ? null : prev))
      }
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [selected, loadIntel])

  async function handleStart(lead: LiLead) {
    if (!lead.id) return
    const res = await chrome.runtime.sendMessage({
      type: MSG.LI_SCRAPER_START,
      payload: { leadId: lead.id, companyName: lead.companyName, linkedInUrl: lead.linkedinUrl, mssqlId: lead.mssqlId },
    }).catch((err) => ({ ok: false, error: err?.message }))
    if (res?.ok) {
      toast.success(`LinkedIn intelligence scrape started for ${lead.companyName}`)
    } else {
      toast.error(res?.error ?? 'Failed to start LinkedIn scrape')
    }
  }

  async function handleCancel() {
    await chrome.runtime.sendMessage({ type: MSG.LI_SCRAPER_CANCEL }).catch(() => {})
    setJob(null)
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">Loading LinkedIn intelligence…</div>
  }

  const jobIsForSelected = job && selected && job.leadId === selected.id

  return (
    <div className="flex-1 flex gap-4 min-h-0">
      {/* Left list */}
      <div className="w-80 shrink-0 flex flex-col gap-2 min-h-0">
        <h3 className="text-sm font-semibold text-white">Companies with LinkedIn ({leads.length})</h3>
        <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
          {leads.length === 0 && (
            <div className="text-xs text-gray-600 px-2 py-8 text-center">
              No companies with a discovered LinkedIn URL yet — run Company Intelligence research first.
            </div>
          )}
          {leads.map((lead) => (
            <button
              key={lead.id}
              onClick={() => setSelected(lead)}
              className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                selected?.id === lead.id ? 'bg-blue-950/50 border-blue-700' : 'bg-gray-900 border-gray-800 hover:border-gray-700'
              }`}
            >
              <div className="text-sm font-medium text-white truncate">{lead.companyName}</div>
              <div className="text-xs text-gray-500 mt-0.5 truncate">{lead.city}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Detail */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {!selected ? (
          <div className="h-full flex items-center justify-center text-gray-600 text-sm">Select a company to view LinkedIn intelligence</div>
        ) : (
          <LinkedInDetail
            lead={selected}
            intel={intel}
            intelLoading={intelLoading}
            job={jobIsForSelected ? job : null}
            onStart={() => handleStart(selected)}
            onCancel={handleCancel}
          />
        )}
      </div>
    </div>
  )
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
      confidence >= 0.7 ? 'bg-green-950 text-green-400' : confidence >= 0.4 ? 'bg-yellow-950 text-yellow-400' : 'bg-red-950 text-red-400'
    }`}>{Math.round(confidence * 100)}%</span>
  )
}

function SignalBadges({ post }: { post: { hiringSignal: boolean; expansionSignal: boolean; productSignal: boolean; eventSignal: boolean } }) {
  const tags = [
    post.hiringSignal && { label: 'Hiring', cls: 'bg-blue-950 text-blue-400' },
    post.expansionSignal && { label: 'Expansion', cls: 'bg-purple-950 text-purple-400' },
    post.productSignal && { label: 'Product', cls: 'bg-cyan-950 text-cyan-400' },
    post.eventSignal && { label: 'Event', cls: 'bg-orange-950 text-orange-400' },
  ].filter(Boolean) as { label: string; cls: string }[]
  if (tags.length === 0) return null
  return (
    <div className="flex gap-1 mt-1">
      {tags.map((t) => (
        <span key={t.label} className={`text-[10px] px-1.5 py-0.5 rounded-full ${t.cls}`}>{t.label}</span>
      ))}
    </div>
  )
}

function LinkedInDetail({
  lead, intel, intelLoading, job, onStart, onCancel,
}: {
  lead: LiLead
  intel: LinkedInIntelligence | null
  intelLoading: boolean
  job: LinkedInScraperJob | null
  onStart: () => void
  onCancel: () => void
}) {
  const isRunning = job?.status === 'running'
  const hiringPosts = intel?.companyPosts.filter((p) => p.hiringSignal) ?? []

  return (
    <div className="space-y-5 pb-6">
      {/* Header / trigger */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">{lead.companyName}</h2>
            <a href={lead.linkedinUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:underline break-all">{lead.linkedinUrl}</a>
          </div>
          {isRunning ? (
            <button onClick={onCancel} className="text-xs px-3 py-1.5 bg-red-900/40 hover:bg-red-900/60 text-red-300 rounded-lg transition-colors shrink-0">
              Cancel scrape
            </button>
          ) : (
            <button onClick={onStart} className="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors shrink-0">
              {intel?.companyProfile ? 'Re-scan LinkedIn' : 'Scan LinkedIn'}
            </button>
          )}
        </div>
        {job && (
          <div className="bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-xs space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-gray-400">Step: {job.step}</span>
              <span className={`px-1.5 py-0.5 rounded-full ${
                job.status === 'running' ? 'bg-blue-950 text-blue-400'
                  : job.status === 'done' ? 'bg-green-950 text-green-400'
                  : 'bg-red-950 text-red-400'
              }`}>{job.status}</span>
            </div>
            <div className="max-h-24 overflow-y-auto text-gray-500 space-y-0.5">
              {job.log.slice(-6).map((l, i) => <div key={i}>{l}</div>)}
            </div>
          </div>
        )}
        <p className="text-[11px] text-gray-600">
          Only data publicly visible on LinkedIn is captured — no login bypass, captcha solving, or private pages.
          Fields not visible are stored as "Not Available".
        </p>
      </section>

      {intelLoading && <div className="text-xs text-gray-500 px-1">Loading saved intelligence…</div>}

      {!intelLoading && !intel?.companyProfile && (
        <div className="text-xs text-gray-600 px-1">No LinkedIn intelligence saved yet for this company.</div>
      )}

      {intel?.companyProfile && (
        <>
          {/* Company profile */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Company Profile</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Industry" value={intel.companyProfile.industry} />
              <Field label="Company Size" value={intel.companyProfile.companySize} />
              <Field label="Followers" value={intel.companyProfile.followers} />
              <Field label="Location" value={intel.companyProfile.location} />
            </div>
            {intel.companyProfile.aboutText && (
              <div>
                <div className="text-xs text-gray-500 mb-1">About</div>
                <div className="text-sm text-gray-300 whitespace-pre-wrap">{intel.companyProfile.aboutText}</div>
              </div>
            )}
          </section>

          {/* Hiring signals */}
          {hiringPosts.length > 0 && (
            <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Hiring Signals ({hiringPosts.length})</h3>
              {hiringPosts.map((p, i) => (
                <div key={i} className="text-xs bg-gray-950 border border-gray-800 rounded-lg p-2.5">
                  <div className="text-gray-500">{p.postDate}</div>
                  <div className="text-gray-300 mt-0.5">{p.postText}</div>
                </div>
              ))}
            </section>
          )}

          {/* Company activity timeline */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Company Activity — Last 6 Months ({intel.companyPosts.length})</h3>
            {intel.companyPosts.length === 0 ? (
              <div className="text-xs text-gray-600">No public company posts found in the last 6 months.</div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {intel.companyPosts.map((p, i) => (
                  <div key={i} className="text-xs bg-gray-950 border border-gray-800 rounded-lg p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-gray-500">{p.postDate}</span>
                      <span className="text-gray-600">{p.detectedTheme}{p.engagementCount !== null ? ` · ${p.engagementCount} engagements` : ''}</span>
                    </div>
                    <div className="text-gray-300 mt-1">{p.postText}</div>
                    {p.postUrl && <a href={p.postUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline break-all block mt-1">{p.postUrl}</a>}
                    <SignalBadges post={p} />
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Core team list */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Core Team ({intel.people.length})</h3>
            {intel.people.length === 0 ? (
              <div className="text-xs text-gray-600">No core team members publicly identified.</div>
            ) : (
              <div className="space-y-1.5">
                {intel.people.map((p, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 text-xs bg-gray-950 border border-gray-800 rounded-lg p-2.5">
                    <div className="min-w-0">
                      <div className="text-gray-200 font-medium truncate">{p.name} <span className="text-gray-500 font-normal">— {p.title}</span></div>
                      <div className="text-gray-600 mt-0.5">{p.roleCategory}</div>
                      {p.linkedinUrl && <a href={p.linkedinUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline break-all">{p.linkedinUrl}</a>}
                    </div>
                    <ConfidenceBadge confidence={p.confidence} />
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Person activity timeline */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Core Team Activity — Last 6 Months ({intel.personPosts.length})</h3>
            {intel.personPosts.length === 0 ? (
              <div className="text-xs text-gray-600">No public posts found from core team members in the last 6 months.</div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {intel.personPosts.map((p, i) => (
                  <div key={i} className="text-xs bg-gray-950 border border-gray-800 rounded-lg p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-gray-300 font-medium">{p.personName}</span>
                      <span className="text-gray-500">{p.postDate}</span>
                    </div>
                    <div className="text-gray-300 mt-1">{p.postText}</div>
                    {p.postUrl && <a href={p.postUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline break-all block mt-1">{p.postUrl}</a>}
                    <div className="flex items-center gap-2 mt-1">
                      {p.detectedTheme && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-800 text-gray-400">{p.detectedTheme}</span>}
                      {p.hiringSignal && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-950 text-blue-400">Hiring</span>}
                      {p.companyMention && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-950 text-green-400">Mentions {lead.companyName}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value?: string }) {
  if (!value) return null
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-sm text-gray-200">{value}</div>
    </div>
  )
}
