import React, { useEffect, useState } from 'react'
import { toast } from '@/state/useToastStore'
import { updateStage } from '@/services/outreachService'
import type { OutreachConversation } from '@/services/outreachService'
import { STAGE_META, CHANNEL_META } from '@/services/outreachService'
import type { ConversationStage } from '@/services/outreachService'
import { exportRowsToCSV, type ExportRowInput } from '@/utils/csvExport'

const API = 'http://localhost:5150'

interface FollowUpItem {
  conversationId: string
  companyId: string
  companyName: string
  city: string
  channel: string
  contactName: string
  stage: ConversationStage
  nextFollowUpAt: string
  notes?: string
  lastActivityAt: string
}

export default function FollowUpPanel() {
  const [items, setItems] = useState<FollowUpItem[]>([])
  const [loading, setLoading] = useState(true)
  const [apiDown, setApiDown] = useState(false)
  const [snoozeId, setSnoozeId] = useState<string | null>(null)
  const [snoozeDate, setSnoozeDate] = useState('')
  const [filter, setFilter] = useState<'due' | 'upcoming'>('due')

  async function load() {
    try {
      const endpoint = filter === 'due' ? '/api/followups/due' : '/api/followups/upcoming'
      const res = await fetch(`${API}${endpoint}`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) { setApiDown(true); setLoading(false); return }
      setApiDown(false)
      const data = await res.json()
      setItems(data.followups ?? [])
    } catch {
      setApiDown(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [filter])

  async function handleSnooze(item: FollowUpItem) {
    if (!snoozeDate) { toast.error('Pick a date'); return }
    // updateStage returns { ok: boolean } — must check result.ok, not the object itself
    const result = await updateStage({
      conversationId: item.conversationId,
      stage: item.stage,
      notes: item.notes,
      nextFollowUpAt: new Date(snoozeDate),
    })
    if (result.ok) {
      toast.success(`Snoozed until ${snoozeDate}`)
      setSnoozeId(null)
      setSnoozeDate('')
      load()
    } else {
      toast.error('Failed to snooze')
    }
  }

  async function handleMarkDone(item: FollowUpItem) {
    // Advance to the next stage in the pipeline. If already at 'won' or 'lost',
    // the fallback keeps the current stage so we never accidentally move backwards.
    const nextStage: ConversationStage =
      item.stage === 'contacted'         ? 'replied' :
      item.stage === 'replied'           ? 'nurturing' :
      item.stage === 'nurturing'         ? 'meeting_scheduled' :
      item.stage === 'meeting_scheduled' ? 'won' :
      item.stage

    const result = await updateStage({
      conversationId: item.conversationId,
      stage: nextStage,
    })
    if (result.ok) {
      toast.success(`Moved to ${STAGE_META[nextStage]?.label ?? nextStage}`)
      load()
    } else {
      toast.error('Update failed')
    }
  }

  function handleExportCSV() {
    const rows: ExportRowInput[] = items.map((item) => ({
      name: item.contactName || item.companyName,
      tags: item.city,
      creationDate: item.lastActivityAt,
      companyName: item.companyName,
    }))
    exportRowsToCSV(rows, `followups-${filter}-export-${Date.now()}.csv`)
  }

  function daysOverdue(dateStr: string): number {
    const due = new Date(dateStr)
    const now = new Date()
    return Math.floor((now.getTime() - due.getTime()) / (1000 * 60 * 60 * 24))
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  }

  if (apiDown) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
        <div className="text-3xl opacity-30">⏰</div>
        <div className="text-gray-500 text-sm">Follow-up data needs the local API</div>
        <div className="text-gray-700 text-xs">Start the DeepLead API → <span className="font-mono">dotnet run</span></div>
        <button
          onClick={load}
          className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white">Follow-Up Scheduler</h2>
          <p className="text-xs text-gray-500 mt-0.5">Conversations with a scheduled follow-up date</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCSV}
            className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg transition-colors border border-gray-700"
          >
            ⤓ CSV
          </button>
          <button
            onClick={load}
            className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {(['due', 'upcoming'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-colors capitalize ${
              filter === f ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {f === 'due' ? '⚠ Due / Overdue' : '📅 Upcoming'}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="space-y-2">
            {[1,2,3].map(i => (
              <div key={i} className="h-20 bg-gray-900 border border-gray-800 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-3 text-center bg-gray-900 border border-gray-800 rounded-xl">
            <div className="text-3xl opacity-30">✓</div>
            <div className="text-gray-500 text-sm">
              {filter === 'due' ? 'No overdue follow-ups — you\'re all caught up!' : 'No upcoming follow-ups scheduled'}
            </div>
            <div className="text-gray-700 text-xs">
              Set follow-up dates from the Outreach panel → Stage tab
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map(item => {
              const overdue = filter === 'due' ? daysOverdue(item.nextFollowUpAt) : 0
              const stageMeta = STAGE_META[item.stage] ?? { label: item.stage, color: 'text-gray-400', bg: 'bg-gray-800' }
              const channelMeta = CHANNEL_META[item.channel as keyof typeof CHANNEL_META]
              const isSnoozing = snoozeId === item.conversationId

              return (
                <div
                  key={item.conversationId}
                  className={`bg-gray-900 border rounded-xl px-4 py-3 space-y-2 ${
                    overdue > 0 ? 'border-orange-800/60' : 'border-gray-800'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white truncate">{item.companyName}</span>
                        <span className="text-xs text-gray-600">{item.city}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {channelMeta && (
                          <span className="text-xs text-gray-400">
                            {channelMeta.icon} {channelMeta.label}
                          </span>
                        )}
                        <span className={`text-xs px-1.5 py-0.5 rounded ${stageMeta.bg} ${stageMeta.color}`}>
                          {stageMeta.label}
                        </span>
                        {item.contactName && (
                          <span className="text-xs text-gray-500">→ {item.contactName}</span>
                        )}
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      {overdue > 0 ? (
                        <div className="text-xs text-orange-400 font-medium">
                          {overdue === 1 ? '1 day overdue' : `${overdue} days overdue`}
                        </div>
                      ) : (
                        <div className="text-xs text-gray-400">Due {formatDate(item.nextFollowUpAt)}</div>
                      )}
                      <div className="text-xs text-gray-600 mt-0.5">{formatDate(item.nextFollowUpAt)}</div>
                    </div>
                  </div>

                  {item.notes && (
                    <div className="text-xs text-gray-500 bg-gray-800 rounded-lg px-2.5 py-1.5 italic">
                      {item.notes}
                    </div>
                  )}

                  {/* Snooze form */}
                  {isSnoozing && (
                    <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2">
                      <span className="text-xs text-gray-400">Snooze to:</span>
                      <input
                        type="date"
                        value={snoozeDate}
                        min={new Date().toISOString().split('T')[0]}
                        onChange={e => setSnoozeDate(e.target.value)}
                        className="bg-gray-700 border border-gray-600 text-white text-xs px-2 py-1 rounded-lg
                          focus:outline-none focus:border-blue-500"
                      />
                      <button
                        onClick={() => handleSnooze(item)}
                        className="text-xs px-2.5 py-1 bg-blue-700 hover:bg-blue-600 text-white rounded-lg transition-colors"
                      >
                        Set
                      </button>
                      <button
                        onClick={() => setSnoozeId(null)}
                        className="text-xs text-gray-500 hover:text-white transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  )}

                  {/* Actions */}
                  {!isSnoozing && (
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => handleMarkDone(item)}
                        className="text-xs px-2.5 py-1 bg-green-900 hover:bg-green-800 text-green-300 rounded-lg transition-colors"
                      >
                        ✓ Followed Up
                      </button>
                      <button
                        onClick={() => { setSnoozeId(item.conversationId); setSnoozeDate('') }}
                        className="text-xs px-2.5 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg transition-colors"
                      >
                        ⏰ Snooze
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
