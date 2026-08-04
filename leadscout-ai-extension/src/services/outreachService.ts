// Outreach service — logs all sent messages + stage changes to MSSQL.
// Works alongside interaktService.ts (WhatsApp) and direct channel opens (LinkedIn, Email, etc.)

import { API_BASE as API } from '@/config/api'

export type OutreachChannel = 'whatsapp' | 'linkedin' | 'email' | 'instagram' | 'facebook'

export type ConversationStage =
  | 'cold'
  | 'contacted'
  | 'replied'
  | 'nurturing'
  | 'meeting_scheduled'
  | 'won'
  | 'lost'

export interface OutreachConversation {
  id: string
  channel: OutreachChannel
  contactName: string
  stage: ConversationStage
  lastActivityAt: string
  nextFollowUpAt?: string
  notes?: string
}

export interface ConversationMessage {
  id: string
  conversationId: string
  direction: 'outbound' | 'inbound'
  content: string
  channel: OutreachChannel
  sentAt: string
}

// Log an outbound message (sent by us) to MSSQL.
// Creates the conversation thread if it doesn't exist yet.
export async function logOutboundMessage(options: {
  companyId: string
  channel: OutreachChannel
  contactName: string
  contactId?: string
  messageText: string
}): Promise<{ ok: boolean; conversationId?: string; error?: string }> {
  try {
    const res = await fetch(`${API}/api/outreach/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyId:   options.companyId,
        channel:     options.channel,
        contactName: options.contactName,
        contactId:   options.contactId ?? null,
        messageText: options.messageText,
      }),
    })
    const data = await res.json()
    return { ok: data.ok, conversationId: data.conversationId }
  } catch (err: any) {
    return { ok: false, error: err?.message }
  }
}

// Log an inbound reply (received from prospect).
// Advances the conversation stage to 'replied'.
export async function logReply(options: {
  conversationId: string
  channel: OutreachChannel
  replyText: string
}): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`${API}/api/outreach/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: options.conversationId,
        channel:        options.channel,
        replyText:      options.replyText,
      }),
    })
    const data = await res.json()
    return { ok: data.ok }
  } catch {
    return { ok: false }
  }
}

// Move the conversation to a new stage (e.g. replied → nurturing → meeting_scheduled).
export async function updateStage(options: {
  conversationId: string
  stage: ConversationStage
  notes?: string
  nextFollowUpAt?: Date
}): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`${API}/api/outreach/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: options.conversationId,
        stage:          options.stage,
        notes:          options.notes ?? null,
        nextFollowUpAt: options.nextFollowUpAt?.toISOString() ?? null,
      }),
    })
    const data = await res.json()
    return { ok: data.ok }
  } catch {
    return { ok: false }
  }
}

// Fetch full outreach history for a company.
export async function getOutreachHistory(companyId: string): Promise<{
  conversations: OutreachConversation[]
  messages: ConversationMessage[]
} | null> {
  try {
    const res = await fetch(`${API}/api/outreach/${companyId}`)
    const data = await res.json()
    if (!data.ok) return null
    return {
      conversations: data.conversations ?? [],
      messages:      data.messages ?? [],
    }
  } catch {
    return null
  }
}

// Open the relevant platform in a new tab with a pre-filled message.
// For WhatsApp this opens wa.me as a fallback when Interakt is not configured.
export function openChannelWithMessage(
  channel: OutreachChannel,
  options: {
    phone?: string
    email?: string
    linkedInUrl?: string
    instagramUrl?: string
    facebookUrl?: string
    message: string
    subject?: string
  }
): void {
  let url = ''

  switch (channel) {
    case 'whatsapp': {
      if (!options.phone) return
      const digits = options.phone.replace(/\D/g, '')
      const phone = digits.startsWith('91') ? digits : `91${digits}`
      url = `https://wa.me/${phone}?text=${encodeURIComponent(options.message)}`
      break
    }
    case 'linkedin': {
      // Open their profile — user clicks "Message" button there
      url = options.linkedInUrl ?? 'https://www.linkedin.com'
      break
    }
    case 'email': {
      if (!options.email) return
      const subject = encodeURIComponent(options.subject ?? 'Quick Introduction')
      const body    = encodeURIComponent(options.message)
      url = `mailto:${options.email}?subject=${subject}&body=${body}`
      break
    }
    case 'instagram': {
      url = options.instagramUrl ?? 'https://www.instagram.com'
      break
    }
    case 'facebook': {
      url = options.facebookUrl ?? 'https://www.facebook.com'
      break
    }
  }

  if (url) {
    if (url.startsWith('mailto:')) {
      window.location.href = url
    } else {
      window.open(url, '_blank')
    }
  }
}

// Stage label + color for UI display
export const STAGE_META: Record<ConversationStage, { label: string; color: string; bg: string }> = {
  cold:               { label: 'Not Contacted', color: 'text-gray-400',   bg: 'bg-gray-800' },
  contacted:          { label: 'Contacted',     color: 'text-blue-400',   bg: 'bg-blue-950/40' },
  replied:            { label: 'Replied',        color: 'text-yellow-400', bg: 'bg-yellow-950/40' },
  nurturing:          { label: 'Nurturing',      color: 'text-purple-400', bg: 'bg-purple-950/40' },
  meeting_scheduled:  { label: 'Meeting Set',    color: 'text-orange-400', bg: 'bg-orange-950/40' },
  won:                { label: 'Won',            color: 'text-green-400',  bg: 'bg-green-950/40' },
  lost:               { label: 'Lost',           color: 'text-red-400',    bg: 'bg-red-900/30' },
}

export const CHANNEL_META: Record<OutreachChannel, { label: string; icon: string; color: string }> = {
  whatsapp:  { label: 'WhatsApp',  icon: '💬', color: 'bg-green-700 hover:bg-green-600' },
  linkedin:  { label: 'LinkedIn',  icon: '💼', color: 'bg-blue-700 hover:bg-blue-600' },
  email:     { label: 'Email',     icon: '✉',  color: 'bg-gray-700 hover:bg-gray-600' },
  instagram: { label: 'Instagram', icon: '📸', color: 'bg-pink-700 hover:bg-pink-600' },
  facebook:  { label: 'Facebook',  icon: '📘', color: 'bg-indigo-700 hover:bg-indigo-600' },
}
