// A person/company the user is already in touch with (existing client, ongoing
// conversation, etc.) — uploaded so outreach can hard-block duplicate messaging.
export interface ExistingClient {
  id?: number
  mssqlId?: string
  companyName: string
  normalizedName: string
  city?: string
  phone?: string
  normalizedPhone?: string
  contactName?: string
  email?: string
  notes?: string
  uploadedAt: string
}
