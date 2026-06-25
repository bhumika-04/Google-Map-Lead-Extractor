import { create } from 'zustand'
import type { Lead, LeadStatus, LeadFilter } from '@/types/lead'
import { leadRepository } from '@/db/leadRepository'
import { saveLeadValidationToSql } from '@/services/sqlSyncService'

interface LeadState {
  leads: Lead[]
  selectedIds: Set<number>
  filter: LeadFilter
  loading: boolean
  detailLead: Lead | null
  loadLeads: (filter?: LeadFilter) => Promise<void>
  addLead: (lead: Lead) => void
  updateLeadStatus: (id: number, status: LeadStatus) => Promise<void>
  updateLeadNotes: (id: number, notes: string) => Promise<void>
  updateLeadTags: (id: number, tags: string[]) => Promise<void>
  toggleSelect: (id: number) => void
  selectAll: () => void
  clearSelection: () => void
  setFilter: (filter: LeadFilter) => void
  deleteLead: (id: number) => Promise<void>
  openDetail: (lead: Lead) => void
  closeDetail: () => void
}

export const useLeadStore = create<LeadState>((set, get) => ({
  leads: [],
  selectedIds: new Set(),
  filter: {},
  loading: false,
  detailLead: null,

  async loadLeads(filter) {
    set({ loading: true })
    const f = filter ?? get().filter
    const leads = await leadRepository.getByFilter(f)
    set({ leads, loading: false, filter: f })
  },

  addLead(lead) {
    set((s) => ({ leads: [lead, ...s.leads] }))
  },

  async updateLeadStatus(id, status) {
    await leadRepository.updateStatus(id, status)
    set((s) => ({
      leads: s.leads.map((l) => (l.id === id ? { ...l, status } : l)),
      detailLead: s.detailLead?.id === id ? { ...s.detailLead, status } : s.detailLead,
    }))
    // Persist status changes to MSSQL so SYNC_FROM_DB restores them correctly
    const lead = get().leads.find((l) => l.id === id)
    if (lead && (status === 'selected' || status === 'rejected')) {
      saveLeadValidationToSql({
        id: id,
        companyName: lead.companyName,
        city: lead.city,
        keyword: lead.keyword,
        address: lead.address,
        phone: lead.phone,
        website: lead.website,
        googleMapsUrl: lead.googleMapsUrl,
        rating: lead.rating,
        reviewCount: lead.reviewCount,
        category: lead.category,
        validationStatus: status,
      }).catch(() => {})
    }
  },

  async updateLeadNotes(id, notes) {
    await leadRepository.updateNotes(id, notes)
    set((s) => ({
      leads: s.leads.map((l) => (l.id === id ? { ...l, notes } : l)),
      detailLead: s.detailLead?.id === id ? { ...s.detailLead, notes } : s.detailLead,
    }))
  },

  async updateLeadTags(id, tags) {
    await leadRepository.updateTags(id, tags)
    set((s) => ({
      leads: s.leads.map((l) => (l.id === id ? { ...l, tags } : l)),
      detailLead: s.detailLead?.id === id ? { ...s.detailLead, tags } : s.detailLead,
    }))
  },

  toggleSelect(id) {
    set((s) => {
      const next = new Set(s.selectedIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { selectedIds: next }
    })
  },

  selectAll() {
    const ids = get().leads.map((l) => l.id).filter((id): id is number => id !== undefined)
    set({ selectedIds: new Set(ids) })
  },

  clearSelection() {
    set({ selectedIds: new Set() })
  },

  setFilter(filter) {
    set({ filter })
  },

  async deleteLead(id) {
    await leadRepository.delete(id)
    set((s) => ({
      leads: s.leads.filter((l) => l.id !== id),
      selectedIds: (() => { const n = new Set(s.selectedIds); n.delete(id); return n })(),
      detailLead: s.detailLead?.id === id ? null : s.detailLead,
    }))
  },

  openDetail(lead) {
    set({ detailLead: lead })
  },

  closeDetail() {
    set({ detailLead: null })
  },
}))
