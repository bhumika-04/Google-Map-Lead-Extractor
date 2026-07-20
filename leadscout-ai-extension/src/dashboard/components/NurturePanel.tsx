import React, { useEffect, useState } from 'react'
import {
  getTemplates, createTemplate, updateTemplate, deleteTemplate,
  getDueSequences, getAllScheduledSequences, markSequenceSent, skipSequence,
} from '@/services/nurtureService'
import type { NurtureTemplate, NurtureSequenceItem } from '@/services/nurtureService'
import { toast } from '@/state/useToastStore'
import { CHANNEL_META } from '@/services/outreachService'
import { exportRowsToCSV, type ExportRowInput } from '@/utils/csvExport'

const CHANNELS = ['whatsapp', 'linkedin', 'email', 'instagram', 'facebook'] as const
const STAGES   = ['contacted', 'replied', 'nurturing', 'meeting_scheduled'] as const

const STAGE_LABELS: Record<string, string> = {
  contacted: 'After First Contact', replied: 'After Reply',
  nurturing: 'During Nurturing', meeting_scheduled: 'After Meeting Scheduled',
}

type NurtureTab = 'templates' | 'scheduled'

const EMPTY_FORM: Omit<NurtureTemplate, 'id' | 'createdAt'> = {
  name: '', channel: 'whatsapp', stage: 'contacted',
  sequenceStep: 1, delayDays: 3, subject: '', messageTemplate: '',
}

// Template variables shown as quick-insert hints
const TEMPLATE_VARS = [
  { key: '{{contact_name}}', label: 'Contact Name' },
  { key: '{{company_name}}', label: 'Company' },
  { key: '{{city}}',         label: 'City' },
  { key: '{{intent_signal}}',label: 'Intent Signal' },
  { key: '{{pitch}}',        label: 'Pitch' },
]

export default function NurturePanel() {
  const [tab, setTab] = useState<NurtureTab>('templates')
  const [templates, setTemplates] = useState<NurtureTemplate[]>([])
  const [sequences, setSequences] = useState<NurtureSequenceItem[]>([])
  const [loading, setLoading] = useState(true)
  const [apiDown, setApiDown] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [seqFilter, setSeqFilter] = useState<'due' | 'all'>('due')

  async function loadTemplates() {
    try {
      const t = await getTemplates()
      setTemplates(t)
      setApiDown(false)
    } catch {
      // getTemplates() throws when the local API is unreachable — show the "start API" error state.
      // getDueSequences/getAllScheduledSequences swallow errors instead (called from service worker alarm).
      setApiDown(true)
    } finally {
      setLoading(false)
    }
  }

  async function loadSequences() {
    const seq = seqFilter === 'due' ? await getDueSequences() : await getAllScheduledSequences()
    setSequences(seq)
  }

  useEffect(() => {
    if (tab === 'templates') loadTemplates()
    else loadSequences()
  }, [tab, seqFilter])

  function startEdit(t: NurtureTemplate) {
    setEditingId(t.id)
    setForm({ name: t.name, channel: t.channel, stage: t.stage, sequenceStep: t.sequenceStep,
      delayDays: t.delayDays, subject: t.subject ?? '', messageTemplate: t.messageTemplate })
    setShowForm(true)
  }

  function startNew() {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setShowForm(true)
  }

  async function handleSave() {
    if (!form.name.trim())            { toast.error('Template name required'); return }
    if (!form.messageTemplate.trim()) { toast.error('Message body required'); return }
    setSaving(true)
    try {
      const payload = { ...form, subject: form.subject || undefined }
      if (editingId) {
        const r = await updateTemplate(editingId, payload)
        if (!r.ok) { toast.error('Save failed'); return }
        toast.success('Template updated')
      } else {
        const r = await createTemplate(payload)
        if (!r.ok) { toast.error('Save failed'); return }
        toast.success('Template created')
      }
      setShowForm(false)
      await loadTemplates()
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this template?')) return
    const r = await deleteTemplate(id)
    if (r.ok) { toast.success('Deleted'); await loadTemplates() }
    else toast.error('Delete failed')
  }

  async function handleMarkSent(id: string) {
    await markSequenceSent(id)
    toast.success('Marked as sent')
    await loadSequences()
  }

  async function handleSkip(id: string) {
    await skipSequence(id)
    toast.info('Skipped')
    await loadSequences()
  }

  function insertVar(v: string) {
    setForm(f => ({ ...f, messageTemplate: f.messageTemplate + v }))
  }

  function handleExportCSV() {
    const rows: ExportRowInput[] = sequences.map((seq) => ({
      name: seq.contactName || seq.companyName,
      phone: seq.phone,
      tags: seq.city,
      creationDate: seq.scheduledFor,
      companyName: seq.companyName,
    }))
    exportRowsToCSV(rows, `nurture-${seqFilter}-export-${Date.now()}.csv`)
  }

  if (apiDown) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
        <div className="text-3xl opacity-30">◎</div>
        <div className="text-gray-500 text-sm">Nurture templates need the local API</div>
        <div className="text-gray-700 text-xs">Start DeepLead API → <span className="font-mono">dotnet run</span></div>
        <button onClick={loadTemplates}
          className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors">
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white">Nurture Sequences</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Define message templates + schedule follow-up sequences for leads in nurturing
          </p>
        </div>
        {tab === 'templates' && !showForm && (
          <button onClick={startNew}
            className="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors shrink-0">
            + New Template
          </button>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {(['templates', 'scheduled'] as const).map(t => (
          <button key={t} onClick={() => { setTab(t); setShowForm(false) }}
            className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-colors capitalize ${
              tab === t ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
            }`}>
            {t === 'templates' ? '📋 Templates' : '📅 Scheduled'}
          </button>
        ))}
      </div>

      {/* ── Templates tab ── */}
      {tab === 'templates' && (
        <div className="flex-1 overflow-auto space-y-3">
          {/* Template form */}
          {showForm && (
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-semibold text-white">
                {editingId ? 'Edit Template' : 'New Template'}
              </h3>

              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="text-xs text-gray-400 block mb-1">Template Name</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Day 3 WhatsApp Follow-up"
                    className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg
                      focus:outline-none focus:border-blue-500 placeholder-gray-600"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-400 block mb-1">Channel</label>
                  <select value={form.channel} onChange={e => setForm(f => ({ ...f, channel: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg
                      focus:outline-none focus:border-blue-500">
                    {CHANNELS.map(c => (
                      <option key={c} value={c}>
                        {CHANNEL_META[c]?.icon} {CHANNEL_META[c]?.label ?? c}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs text-gray-400 block mb-1">Send When</label>
                  <select value={form.stage} onChange={e => setForm(f => ({ ...f, stage: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg
                      focus:outline-none focus:border-blue-500">
                    {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
                  </select>
                </div>

                <div>
                  <label className="text-xs text-gray-400 block mb-1">Delay (days after trigger)</label>
                  <input
                    type="number" min={0} max={90}
                    value={form.delayDays}
                    onChange={e => setForm(f => ({ ...f, delayDays: Number(e.target.value) }))}
                    className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg
                      focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-400 block mb-1">Sequence Step</label>
                  <input
                    type="number" min={1} max={20}
                    value={form.sequenceStep}
                    onChange={e => setForm(f => ({ ...f, sequenceStep: Number(e.target.value) }))}
                    className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg
                      focus:outline-none focus:border-blue-500"
                  />
                </div>

                {form.channel === 'email' && (
                  <div className="col-span-2">
                    <label className="text-xs text-gray-400 block mb-1">Email Subject</label>
                    <input
                      type="text"
                      value={form.subject ?? ''}
                      onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
                      placeholder="Subject line"
                      className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg
                        focus:outline-none focus:border-blue-500 placeholder-gray-600"
                    />
                  </div>
                )}

                <div className="col-span-2">
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs text-gray-400">Message Body</label>
                    <div className="flex gap-1 flex-wrap justify-end">
                      {TEMPLATE_VARS.map(v => (
                        <button key={v.key} onClick={() => insertVar(v.key)}
                          className="text-xs px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white
                            border border-gray-700 rounded transition-colors font-mono">
                          {v.key}
                        </button>
                      ))}
                    </div>
                  </div>
                  <textarea
                    value={form.messageTemplate}
                    onChange={e => setForm(f => ({ ...f, messageTemplate: e.target.value }))}
                    rows={5}
                    placeholder="Hi {{contact_name}}, following up on behalf of {{company_name}}..."
                    className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg
                      focus:outline-none focus:border-blue-500 placeholder-gray-600 resize-none"
                  />
                  <div className="text-xs text-gray-700 mt-1">
                    Use {TEMPLATE_VARS.map(v => v.key).join(', ')} as placeholders
                  </div>
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <button onClick={handleSave} disabled={saving}
                  className="flex-1 text-sm px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50
                    text-white rounded-lg transition-colors font-medium">
                  {saving ? 'Saving…' : (editingId ? 'Update Template' : 'Create Template')}
                </button>
                <button onClick={() => setShowForm(false)}
                  className="text-sm px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Template list */}
          {loading ? (
            <div className="space-y-2">
              {[1,2,3].map(i => <div key={i} className="h-20 bg-gray-900 border border-gray-800 rounded-xl animate-pulse" />)}
            </div>
          ) : templates.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-center bg-gray-900 border border-gray-800 rounded-xl">
              <div className="text-3xl opacity-30">◎</div>
              <div className="text-gray-500 text-sm">No nurture templates yet</div>
              <button onClick={startNew} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
                Create your first template →
              </button>
            </div>
          ) : (
            templates.map(t => (
              <div key={t.id} className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl px-4 py-3 group transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-white">{t.name}</span>
                      <span className="text-xs text-gray-500">
                        {CHANNEL_META[t.channel as keyof typeof CHANNEL_META]?.icon} {t.channel}
                      </span>
                      <span className="text-xs px-1.5 py-0.5 bg-gray-800 border border-gray-700 text-gray-400 rounded">
                        Step {t.sequenceStep}
                      </span>
                      <span className="text-xs text-blue-400">
                        +{t.delayDays} days
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">{STAGE_LABELS[t.stage] ?? t.stage}</div>
                    <div className="text-xs text-gray-600 mt-1 line-clamp-2">{t.messageTemplate}</div>
                  </div>
                  <div className="flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => startEdit(t)}
                      className="text-xs px-2.5 py-1 bg-gray-800 hover:bg-blue-900 text-gray-400 hover:text-blue-300 rounded-lg transition-colors">
                      Edit
                    </button>
                    <button onClick={() => handleDelete(t.id)}
                      className="text-xs px-2.5 py-1 bg-gray-800 hover:bg-red-900 text-gray-400 hover:text-red-300 rounded-lg transition-colors">
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── Scheduled sequences tab ── */}
      {tab === 'scheduled' && (
        <div className="flex-1 overflow-auto space-y-3">
          <div className="flex items-center gap-2">
            <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1">
              {(['due', 'all'] as const).map(f => (
                <button key={f} onClick={() => setSeqFilter(f)}
                  className={`px-3 py-1 text-xs rounded-lg transition-colors capitalize ${
                    seqFilter === f ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
                  }`}>
                  {f === 'due' ? '⚠ Due' : 'All Scheduled'}
                </button>
              ))}
            </div>
            <button onClick={loadSequences}
              className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg transition-colors">
              Refresh
            </button>
            <button onClick={handleExportCSV}
              className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg transition-colors border border-gray-700">
              ⤓ CSV
            </button>
          </div>

          {sequences.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-center bg-gray-900 border border-gray-800 rounded-xl">
              <div className="text-3xl opacity-30">📅</div>
              <div className="text-gray-500 text-sm">
                {seqFilter === 'due' ? 'No sequences due right now' : 'No sequences scheduled'}
              </div>
              <div className="text-gray-700 text-xs">
                Schedule sequences from the Outreach panel → Nurture tab
              </div>
            </div>
          ) : (
            sequences.map(seq => (
              <div key={seq.id} className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 space-y-2 group">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white">{seq.companyName}</div>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap text-xs">
                      <span className="text-gray-500">{CHANNEL_META[seq.channel as keyof typeof CHANNEL_META]?.icon} {seq.channel}</span>
                      <span className="text-gray-600">{seq.templateName}</span>
                      <span className="text-gray-500">
                        Due {new Date(seq.scheduledFor).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                      </span>
                    </div>
                    <div className="text-xs text-gray-600 mt-1 line-clamp-2 italic">{seq.messageTemplate}</div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button onClick={() => handleMarkSent(seq.id)}
                      className="text-xs px-2.5 py-1 bg-green-900 hover:bg-green-800 text-green-300 rounded-lg transition-colors">
                      ✓ Sent
                    </button>
                    <button onClick={() => handleSkip(seq.id)}
                      className="text-xs px-2.5 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg transition-colors">
                      Skip
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
