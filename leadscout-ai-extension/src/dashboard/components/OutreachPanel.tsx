import React, { useState, useEffect } from 'react'
import type { ResearchResult } from '../../types/research'
import type { Lead } from '../../types/lead'
import type { DeepResearch } from '../../types/deepResearch'
import type { AppSettings } from '../../types/settings'
import {
  type OutreachChannel,
  type ConversationStage,
  type OutreachConversation,
  type ConversationMessage,
  STAGE_META,
  CHANNEL_META,
  logOutboundMessage,
  logReply,
  updateStage,
  getOutreachHistory,
  openChannelWithMessage,
} from '../../services/outreachService'
import { sendWhatsAppOutreach, buildFirstTouchBodyValues } from '../../services/interaktService'
import { existingClientRepository } from '../../db/existingClientRepository'
import type { ExistingClient } from '../../types/existingClient'

interface Props {
  result: ResearchResult
  lead: Lead                         // always passed from ResearchPage (guarded by result.lead &&)
  deepResearch?: DeepResearch | null
  settings: AppSettings
  mssqlCompanyId?: string | null
}

const STAGE_ORDER: ConversationStage[] = [
  'cold', 'contacted', 'replied', 'nurturing', 'meeting_scheduled', 'won', 'lost',
]

export function OutreachPanel({ result, lead, deepResearch, settings, mssqlCompanyId }: Props) {
  const [conversations, setConversations] = useState<OutreachConversation[]>([])
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [sending, setSending] = useState<OutreachChannel | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [editingMessage, setEditingMessage] = useState<OutreachChannel | null>(null)
  const [messageText, setMessageText] = useState('')
  const [replyText, setReplyText] = useState('')
  const [replyConvId, setReplyConvId] = useState('')
  const [stageConvId, setStageConvId] = useState('')
  const [stageValue, setStageValue] = useState<ConversationStage>('contacted')
  const [followUpDate, setFollowUpDate] = useState('')
  const [notes, setNotes] = useState('')
  const [activeConv, setActiveConv] = useState<OutreachConversation | null>(null)
  const [existingMatch, setExistingMatch] = useState<ExistingClient | null>(null)

  const hasInterakt = !!settings.interaktApiKey && !!settings.interaktTemplateName

  // Hard-block: never message someone already on the existing-clients list.
  useEffect(() => {
    existingClientRepository
      .findMatch(lead.phone, lead.companyName, lead.city)
      .then((m) => setExistingMatch(m ?? null))
  }, [lead.phone, lead.companyName, lead.city])

  // Correct field names from ResearchResult
  const ownerName     = result.decisionMaker
  const ownerLinkedIn = result.decisionMakerLinkedIn
  const linkedInUrl   = result.linkedIn
  const facebookUrl   = result.facebook
  const instagramUrl  = result.instagram

  // ── derive available channels from data ──────────────────────
  const channels: { channel: OutreachChannel; available: boolean; hint: string }[] = [
    {
      channel: 'whatsapp',
      available: !!lead.phone,
      hint: lead.phone ?? 'No phone found',
    },
    {
      channel: 'linkedin',
      available: !!(ownerLinkedIn || linkedInUrl),
      hint: ownerLinkedIn || linkedInUrl || 'No LinkedIn found',
    },
    {
      channel: 'email',
      available: !!result.email,
      hint: result.email ?? 'No email found',
    },
    {
      channel: 'instagram',
      available: !!instagramUrl,
      hint: instagramUrl ?? 'No Instagram found',
    },
    {
      channel: 'facebook',
      available: !!facebookUrl,
      hint: facebookUrl ?? 'No Facebook found',
    },
  ]

  // ── default pitch message ─────────────────────────────────────
  function defaultMessage(channel: OutreachChannel): string {
    const pitch = deepResearch?.recommendedPitch ?? deepResearch?.pitchTemplate ?? ''
    const contactName = ownerName || lead.companyName
    if (pitch) return pitch

    switch (channel) {
      case 'whatsapp':
        return `Hi, I came across ${lead.companyName} and would love to connect briefly. Do you have 5 minutes this week?`
      case 'email':
        return `Hi ${contactName},\n\nI came across ${lead.companyName} and noticed some great work you're doing.\n\nI'd love to share how we help similar businesses — would a quick 10-minute call work this week?\n\nBest regards`
      default:
        return `Hi, I came across ${lead.companyName} and would love to connect!`
    }
  }

  function getConvForChannel(channel: OutreachChannel): OutreachConversation | undefined {
    return conversations.find(c => c.channel === channel)
  }

  // ── load history on mount ─────────────────────────────────────
  useEffect(() => {
    if (!mssqlCompanyId) return
    getOutreachHistory(mssqlCompanyId).then(h => {
      if (h) {
        setConversations(h.conversations)
        setMessages(h.messages)
      }
    })
  }, [mssqlCompanyId])

  // ── open message composer ─────────────────────────────────────
  function openCompose(channel: OutreachChannel) {
    if (existingMatch) return // hard block — see banner above the channel list
    setEditingMessage(channel)
    setMessageText(defaultMessage(channel))
    setError('')
    setSuccess('')
  }

  // ── send message ──────────────────────────────────────────────
  async function handleSend(channel: OutreachChannel) {
    if (existingMatch) {
      setError('Blocked — this contact is on your Existing Clients list.')
      return
    }
    const text = messageText.trim()
    if (!text) return

    setSending(channel)
    setError('')
    setSuccess('')

    try {
      if (channel === 'whatsapp' && hasInterakt && lead.phone) {
        const intentSignal = deepResearch?.intentSignals
          ? (Array.isArray(deepResearch.intentSignals)
              ? deepResearch.intentSignals[0]
              : (JSON.parse(deepResearch.intentSignals as any)?.[0] ?? ''))
          : ''
        const bodyValues = buildFirstTouchBodyValues({
          contactName:  ownerName || lead.companyName,
          companyName:  lead.companyName,
          intentSignal,
          pitch:        text,
        })
        const interaktResult = await sendWhatsAppOutreach({
          phone:        lead.phone,
          contactName:  ownerName || lead.companyName,
          email:        result.email,
          companyName:  lead.companyName,
          city:         lead.city,
          templateName: settings.interaktTemplateName,
          bodyValues,
          apiKey:       settings.interaktApiKey,
          countryCode:  settings.interaktCountryCode || '+91',
          callbackData: mssqlCompanyId ?? undefined,
        })
        if (!interaktResult.ok) {
          setError(`Interakt: ${interaktResult.error}`)
          setSending(null)
          return
        }
      } else {
        openChannelWithMessage(channel, {
          phone:        lead.phone,
          email:        result.email,
          linkedInUrl:  ownerLinkedIn || linkedInUrl,
          instagramUrl: instagramUrl,
          facebookUrl:  facebookUrl,
          message:      text,
          subject:      `Quick intro — ${lead.companyName}`,
        })
      }

      // Log to MSSQL
      if (mssqlCompanyId) {
        const logResult = await logOutboundMessage({
          companyId:   mssqlCompanyId,
          channel,
          contactName: ownerName || lead.companyName,
          messageText: text,
        })
        if (logResult.ok) {
          const h = await getOutreachHistory(mssqlCompanyId)
          if (h) { setConversations(h.conversations); setMessages(h.messages) }
          setSuccess(
            channel === 'whatsapp' && hasInterakt
              ? 'WhatsApp sent via Interakt!'
              : 'Opened — mark as sent once you send it in the app'
          )
        }
      }

      setEditingMessage(null)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to send')
    } finally {
      setSending(null)
    }
  }

  // ── log reply ─────────────────────────────────────────────────
  async function handleLogReply() {
    if (!replyConvId || !replyText.trim()) return
    const conv = conversations.find(c => c.id === replyConvId)
    if (!conv) return
    await logReply({ conversationId: replyConvId, channel: conv.channel, replyText })
    setReplyText('')
    setReplyConvId('')
    if (mssqlCompanyId) {
      const h = await getOutreachHistory(mssqlCompanyId)
      if (h) { setConversations(h.conversations); setMessages(h.messages) }
    }
    setSuccess('Reply logged!')
  }

  // ── update stage ──────────────────────────────────────────────
  async function handleStageUpdate() {
    if (!stageConvId) return
    await updateStage({
      conversationId: stageConvId,
      stage:          stageValue,
      notes:          notes || undefined,
      nextFollowUpAt: followUpDate ? new Date(followUpDate) : undefined,
    })
    if (mssqlCompanyId) {
      const h = await getOutreachHistory(mssqlCompanyId)
      if (h) { setConversations(h.conversations); setMessages(h.messages) }
    }
    setStageConvId('')
    setSuccess('Stage updated!')
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">Outreach</h3>
          <p className="text-xs text-gray-400 mt-0.5">{lead.companyName} · {lead.city}</p>
        </div>
        {deepResearch?.recommendedPitch && (
          <span className="text-xs bg-purple-900/50 text-purple-300 px-2 py-0.5 rounded-full border border-purple-700/50">
            AI pitch ready
          </span>
        )}
      </div>

      {existingMatch && (
        <div className="flex items-center gap-3 bg-red-950/60 border border-red-800/60 rounded-xl px-4 py-3">
          <span className="text-red-400 text-lg shrink-0">⊘</span>
          <div className="text-xs text-red-300">
            <span className="font-semibold">Already in touch.</span> Matched your Existing Clients list
            {existingMatch.phone ? ` by phone (${existingMatch.phone})` : ` by company name (${existingMatch.companyName})`}.
            Sending is blocked to avoid messaging them twice.
          </div>
        </div>
      )}

      {error   && <div className="text-xs text-red-400 bg-red-900/20 border border-red-800/40 rounded p-2">{error}</div>}
      {success && <div className="text-xs text-green-400 bg-green-900/20 border border-green-800/40 rounded p-2">{success}</div>}

      {/* AI Pitch preview */}
      {deepResearch?.recommendedPitch && (
        <div className="bg-purple-950/30 border border-purple-700/40 rounded-lg p-3">
          <p className="text-xs text-purple-300 font-medium mb-1">AI Recommended Pitch</p>
          <p className="text-xs text-gray-300 leading-relaxed">{deepResearch.recommendedPitch}</p>
        </div>
      )}

      {/* Channel buttons */}
      <div className="space-y-2">
        {channels.map(({ channel, available, hint }) => {
          const meta = CHANNEL_META[channel]
          const conv = getConvForChannel(channel)
          const stage = conv ? STAGE_META[conv.stage as ConversationStage] : null
          const isWhatsAppInterakt = channel === 'whatsapp' && hasInterakt

          return (
            <div
              key={channel}
              className={`rounded-lg border ${
                available
                  ? 'border-gray-700/60 bg-gray-800/40'
                  : 'border-gray-800/40 bg-gray-900/20 opacity-50'
              }`}
            >
              <div className="flex items-center justify-between p-2.5">
                <div className="flex items-center gap-2.5">
                  <span className="text-base">{meta.icon}</span>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-white">{meta.label}</span>
                      {channel === 'whatsapp' && (
                        <span className={`text-[10px] px-1.5 py-0 rounded-full border ${
                          hasInterakt
                            ? 'text-green-400 border-green-700/50 bg-green-950/30'
                            : 'text-gray-500 border-gray-700 bg-gray-800/50'
                        }`}>
                          {hasInterakt ? 'via Interakt' : 'manual (wa.me)'}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-gray-500 mt-0.5 truncate max-w-[200px]">{hint}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {stage && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${stage.bg} ${stage.color}`}>
                      {stage.label}
                    </span>
                  )}
                  {available && (
                    <button
                      onClick={() => openCompose(channel)}
                      disabled={sending === channel || !!existingMatch}
                      title={existingMatch ? 'Blocked — already in touch' : undefined}
                      className="text-xs px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-white transition-colors disabled:opacity-50"
                    >
                      {sending === channel ? '...' : existingMatch ? 'Blocked' : conv ? 'Follow up' : 'Send'}
                    </button>
                  )}
                </div>
              </div>

              {/* Message composer */}
              {editingMessage === channel && (
                <div className="border-t border-gray-700/50 p-3 space-y-2">
                  {channel === 'whatsapp' && hasInterakt && (
                    <p className="text-[10px] text-yellow-400/80">
                      Template: <span className="font-mono">{settings.interaktTemplateName}</span>
                    </p>
                  )}
                  <textarea
                    value={messageText}
                    onChange={e => setMessageText(e.target.value)}
                    rows={4}
                    className="w-full text-xs bg-gray-900 border border-gray-700 rounded p-2 text-gray-200 resize-none focus:outline-none focus:border-purple-600"
                    placeholder="Your message..."
                  />
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => setEditingMessage(null)}
                      className="text-xs px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => handleSend(channel)}
                      disabled={sending === channel}
                      className={`text-xs px-3 py-1.5 rounded text-white transition-colors disabled:opacity-50 ${meta.color}`}
                    >
                      {isWhatsAppInterakt
                        ? (sending === channel ? 'Sending...' : 'Send via Interakt')
                        : (sending === channel ? '...' : 'Open & Send')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Conversation threads */}
      {conversations.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">Conversations</p>
          {conversations.map(conv => {
            const convMsgs = messages.filter(m => m.conversationId === conv.id)
            const stageMeta    = STAGE_META[conv.stage as ConversationStage] ?? STAGE_META.cold
            const channelMeta  = CHANNEL_META[conv.channel as OutreachChannel]
            const isActive     = activeConv?.id === conv.id

            return (
              <div key={conv.id} className="border border-gray-700/50 rounded-lg overflow-hidden">
                <button
                  onClick={() => setActiveConv(isActive ? null : conv)}
                  className="w-full flex items-center justify-between p-3 bg-gray-800/40 hover:bg-gray-800/70 transition-colors text-left"
                >
                  <div className="flex items-center gap-2">
                    <span>{channelMeta?.icon}</span>
                    <div>
                      <span className="text-xs text-white font-medium">{channelMeta?.label}</span>
                      <span className="text-[10px] text-gray-500 ml-2">
                        {convMsgs.length} message{convMsgs.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${stageMeta.bg} ${stageMeta.color}`}>
                      {stageMeta.label}
                    </span>
                    {conv.nextFollowUpAt && (
                      <span className="text-[10px] text-orange-400">
                        Follow-up: {new Date(conv.nextFollowUpAt).toLocaleDateString('en-IN')}
                      </span>
                    )}
                    <span className="text-gray-600 text-xs">{isActive ? '▲' : '▼'}</span>
                  </div>
                </button>

                {isActive && (
                  <div className="p-3 space-y-3">
                    {/* Message timeline */}
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {convMsgs.map(msg => (
                        <div key={msg.id} className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                          <div className={`max-w-[80%] rounded-lg px-3 py-2 text-xs ${
                            msg.direction === 'outbound'
                              ? 'bg-purple-900/50 text-purple-100 border border-purple-700/40'
                              : 'bg-gray-700/60 text-gray-200 border border-gray-600/40'
                          }`}>
                            <p>{msg.content}</p>
                            <p className={`text-[10px] mt-1 ${msg.direction === 'outbound' ? 'text-purple-400' : 'text-gray-500'}`}>
                              {msg.direction === 'outbound' ? 'You' : conv.contactName}
                              {' · '}
                              {new Date(msg.sentAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                            </p>
                          </div>
                        </div>
                      ))}
                      {convMsgs.length === 0 && (
                        <p className="text-xs text-gray-600 text-center py-2">No messages yet</p>
                      )}
                    </div>

                    {/* Log reply */}
                    <div className="border-t border-gray-700/40 pt-3 space-y-2">
                      <p className="text-[11px] text-gray-400 font-medium">Log a reply from them</p>
                      <textarea
                        rows={2}
                        value={replyConvId === conv.id ? replyText : ''}
                        onChange={e => { setReplyConvId(conv.id); setReplyText(e.target.value) }}
                        placeholder="Paste their reply here..."
                        className="w-full text-xs bg-gray-900 border border-gray-700 rounded p-2 text-gray-200 resize-none focus:outline-none focus:border-yellow-600"
                      />
                      <button
                        onClick={handleLogReply}
                        disabled={replyConvId !== conv.id || !replyText.trim()}
                        className="text-xs px-3 py-1.5 rounded bg-yellow-700 hover:bg-yellow-600 text-white disabled:opacity-40"
                      >
                        Log Reply
                      </button>
                    </div>

                    {/* Stage updater */}
                    <div className="border-t border-gray-700/40 pt-3 space-y-2">
                      <p className="text-[11px] text-gray-400 font-medium">Update stage</p>
                      <div className="flex flex-wrap gap-1.5">
                        {STAGE_ORDER.filter(s => s !== 'cold').map(s => {
                          const sm = STAGE_META[s]
                          return (
                            <button
                              key={s}
                              onClick={() => { setStageConvId(conv.id); setStageValue(s) }}
                              className={`text-[10px] px-2 py-1 rounded border transition-colors ${
                                stageConvId === conv.id && stageValue === s
                                  ? `${sm.bg} ${sm.color} border-current`
                                  : 'border-gray-700 text-gray-400 hover:border-gray-500'
                              }`}
                            >
                              {sm.label}
                            </button>
                          )
                        })}
                      </div>
                      {stageConvId === conv.id && (
                        <div className="space-y-1.5">
                          <input
                            type="date"
                            value={followUpDate}
                            onChange={e => setFollowUpDate(e.target.value)}
                            className="text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-300 w-full focus:outline-none focus:border-orange-600"
                          />
                          <input
                            type="text"
                            value={notes}
                            onChange={e => setNotes(e.target.value)}
                            placeholder="Notes (optional)"
                            className="text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-300 w-full focus:outline-none focus:border-orange-600"
                          />
                          <button
                            onClick={handleStageUpdate}
                            className="text-xs px-3 py-1.5 rounded bg-orange-700 hover:bg-orange-600 text-white w-full"
                          >
                            Update Stage
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {!hasInterakt && (
        <div className="text-[10px] text-gray-600 border border-gray-800 rounded p-2 text-center">
          Add your Interakt API key in Settings to send WhatsApp automatically.
          Without it, clicking Send opens wa.me in a new tab.
        </div>
      )}
    </div>
  )
}
