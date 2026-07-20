// Interakt — WhatsApp Business API integration.
// Interakt (interakt.ai) is India's leading WhatsApp Business API platform.
//
// How it works:
//   1. Your Interakt account has pre-approved WhatsApp message templates
//   2. We upsert the contact (phone + name) into Interakt
//   3. We send a template message with variable values filled from research data
//
// The API key from your Interakt dashboard → Settings → Developer → API Key.
// It is stored locally in IndexedDB and never sent to our servers.

const INTERAKT_BASE = 'https://api.interakt.ai/v1/public'

export interface InteraktContact {
  phone: string          // raw phone, any format — we clean it
  name: string
  email?: string
  company?: string
  city?: string
  countryCode?: string   // default '+91'
}

export interface InteraktTemplateMessage {
  phone: string
  countryCode?: string
  templateName: string
  languageCode?: string
  headerValues?: string[]    // {{1}} in template header
  bodyValues: string[]       // {{1}}, {{2}}, ... in template body
  buttonValues?: string[]
  callbackData?: string      // passed back in webhooks (use company ID)
}

export interface InteraktResult {
  ok: boolean
  messageId?: string
  error?: string
}

// Strip everything except digits, remove leading 91 for Indian numbers
function cleanPhone(raw: string, countryCode: string): { digits: string; country: string } {
  let digits = raw.replace(/\D/g, '')
  const cc = countryCode.replace('+', '')

  // Remove leading country code if present (e.g. 919876543210 → 9876543210)
  if (digits.startsWith(cc) && digits.length > 10) {
    digits = digits.slice(cc.length)
  }

  // Handle leading 0 for some Indian numbers
  if (digits.startsWith('0') && digits.length === 11) {
    digits = digits.slice(1)
  }

  return { digits, country: '+' + cc }
}

// Upsert a contact in Interakt before sending a message.
// This syncs the person's name/email/company so Interakt inbox shows the correct info.
export async function interaktUpsertContact(
  contact: InteraktContact,
  apiKey: string,
): Promise<void> {
  const { digits, country } = cleanPhone(contact.phone, contact.countryCode ?? '+91')
  if (digits.length < 10) return   // invalid phone — skip silently

  await fetch(`${INTERAKT_BASE}/track/users/`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      countryCode: country,
      phoneNumber: digits,
      traits: {
        name:    contact.name,
        email:   contact.email ?? '',
        company: contact.company ?? '',
        city:    contact.city ?? '',
      },
    }),
  })
  // We don't throw on failure — upsert is best-effort before send
}

// Send a WhatsApp template message via Interakt.
// The template must be pre-approved in your Interakt account.
// bodyValues replaces {{1}}, {{2}}, ... in the template body in order.
export async function interaktSendTemplate(
  msg: InteraktTemplateMessage,
  apiKey: string,
): Promise<InteraktResult> {
  const { digits, country } = cleanPhone(msg.phone, msg.countryCode ?? '+91')

  if (digits.length < 10) {
    return { ok: false, error: 'Invalid phone number — must be at least 10 digits' }
  }

  const body: Record<string, any> = {
    countryCode:  country,
    phoneNumber:  digits,
    callbackData: msg.callbackData ?? '',
    type:         'Template',
    template: {
      name:         msg.templateName,
      languageCode: msg.languageCode ?? 'en',
      bodyValues:   msg.bodyValues,
    },
  }

  if (msg.headerValues?.length) {
    body.template.headerValues = msg.headerValues
  }
  if (msg.buttonValues?.length) {
    body.template.buttonValues = msg.buttonValues
  }

  try {
    const res = await fetch(`${INTERAKT_BASE}/message/`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      return {
        ok: false,
        error: data?.message ?? data?.error ?? `HTTP ${res.status}`,
      }
    }

    return { ok: true, messageId: data?.id ?? data?.messageId }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Network error' }
  }
}

// High-level helper: upsert contact then send template.
// Use this from the outreach UI — it handles both steps atomically.
export async function sendWhatsAppOutreach(options: {
  phone: string
  contactName: string
  email?: string
  companyName: string
  city?: string
  templateName: string
  bodyValues: string[]
  apiKey: string
  countryCode?: string
  callbackData?: string
}): Promise<InteraktResult> {
  // Step 1: make sure contact exists in Interakt with correct details
  await interaktUpsertContact(
    {
      phone:       options.phone,
      name:        options.contactName,
      email:       options.email,
      company:     options.companyName,
      city:        options.city,
      countryCode: options.countryCode,
    },
    options.apiKey,
  )

  // Step 2: send the template message
  return interaktSendTemplate(
    {
      phone:        options.phone,
      countryCode:  options.countryCode,
      templateName: options.templateName,
      bodyValues:   options.bodyValues,
      callbackData: options.callbackData,
    },
    options.apiKey,
  )
}

// Build body values from research data for the first-touch template.
// Matches the typical Indian B2B outreach template structure:
//   Body: "Hi {{1}}, I came across {{2}} and noticed {{3}}. {{4}}"
export function buildFirstTouchBodyValues(options: {
  contactName: string
  companyName: string
  intentSignal: string   // e.g. "you recently posted about expanding your packaging line"
  pitch: string          // 1-line personalized pitch
}): string[] {
  return [
    options.contactName,
    options.companyName,
    options.intentSignal,
    options.pitch,
  ]
}
