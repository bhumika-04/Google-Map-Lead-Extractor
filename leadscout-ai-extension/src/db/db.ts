import Dexie, { type Table } from 'dexie'
import type { Lead } from '@/types/lead'
import type { SearchSession } from '@/types/searchSession'
import type { SearchProject } from '@/types/searchProject'
import type { ResearchJob, ResearchResult } from '@/types/research'
import type { DeepResearch } from '@/types/deepResearch'
import type { BatchCampaign } from '@/types/batchCampaign'
import type { ExistingClient } from '@/types/existingClient'
import type { SelectedLead, ResearchedLead } from '@/types/derivedLeads'
import type { SessionRecord } from '@/types/session'
import type { ScrapedLead, ImportedLead } from '@/types/pipelineLead'
// SearchEvidence, SourcePage, CompanyResearch removed from IndexedDB (version 8).
// Phase 3 data is stored exclusively in MSSQL via apiResearchService.

export interface ActivityLog {
  id?: number
  sessionId?: number
  type: string
  message: string
  metadata?: Record<string, unknown>
  createdAt: string
}

export interface SettingRecord {
  key: string
  value: string
}

export class LeadScoutDB extends Dexie {
  searchSessions!: Table<SearchSession, number>
  leads!: Table<Lead, number>
  researchJobs!: Table<ResearchJob, number>
  researchResults!: Table<ResearchResult, number>
  deepResearch!: Table<DeepResearch, number>
  activityLogs!: Table<ActivityLog, number>
  settings!: Table<SettingRecord, string>
  batchCampaigns!: Table<BatchCampaign, number>
  existingClients!: Table<ExistingClient, number>
  searchProjects!: Table<SearchProject, number>
  // Dedicated per-stage tables — materialized from `leads` (which stays the master).
  selectedLeads!: Table<SelectedLead, number>
  researchedLeads!: Table<ResearchedLead, number>
  // ─── Redesigned schema (v12) — mirror of MSSQL sessions/scraped_leads/imported_leads.
  // These replace leads/searchProjects going forward; the old tables stay during migration.
  sessions!: Table<SessionRecord, number>
  scrapedLeads!: Table<ScrapedLead, number>
  importedLeads!: Table<ImportedLead, number>
  // searchEvidence, sourcePages, companyResearch removed — Phase 3 data lives in MSSQL only

  constructor() {
    super('LeadScoutAI')

    this.version(1).stores({
      searchSessions: '++id, status, city, keyword, createdAt',
      leads:          '++id, sessionId, status, normalizedName, city, keyword, phone, googleMapsUrl, capturedAt',
      researchJobs:   '++id, leadId, sessionId, status, jobType, createdAt',
      activityLogs:   '++id, sessionId, type, createdAt',
      settings:       'key',
    })

    this.version(2).stores({
      searchSessions: '++id, status, city, keyword, createdAt',
      leads:          '++id, sessionId, status, normalizedName, city, keyword, phone, googleMapsUrl, capturedAt',
      researchJobs:   '++id, leadId, sessionId, status, jobType, createdAt',
      researchResults:'++id, leadId, jobId, createdAt',
      activityLogs:   '++id, sessionId, type, createdAt',
      settings:       'key',
    })

    this.version(3).stores({
      searchSessions: '++id, status, city, keyword, createdAt',
      leads:          '++id, sessionId, status, normalizedName, city, keyword, phone, googleMapsUrl, validationStatus, capturedAt',
      researchJobs:   '++id, leadId, sessionId, status, jobType, createdAt',
      researchResults:'++id, leadId, jobId, createdAt',
      activityLogs:   '++id, sessionId, type, createdAt',
      settings:       'key',
    })

    this.version(4).stores({
      searchSessions: '++id, status, city, keyword, createdAt',
      leads:          '++id, sessionId, status, normalizedName, city, keyword, phone, googleMapsUrl, validationStatus, capturedAt',
      researchJobs:   '++id, leadId, sessionId, status, jobType, createdAt',
      researchResults:'++id, leadId, jobId, createdAt',
      deepResearch:   '++id, researchResultId, leadId, researchedAt',
      activityLogs:   '++id, sessionId, type, createdAt',
      settings:       'key',
    })

    this.version(5).stores({
      searchSessions: '++id, status, city, keyword, createdAt',
      leads:          '++id, sessionId, status, normalizedName, city, keyword, phone, googleMapsUrl, validationStatus, capturedAt',
      researchJobs:   '++id, leadId, sessionId, status, jobType, createdAt',
      researchResults:'++id, leadId, jobId, createdAt',
      deepResearch:   '++id, researchResultId, leadId, researchedAt',
      activityLogs:   '++id, sessionId, type, createdAt',
      settings:       'key',
      batchCampaigns: '++id, status, createdAt',
    })

    this.version(6).stores({
      searchSessions: '++id, status, city, keyword, createdAt',
      leads:          '++id, sessionId, status, normalizedName, city, keyword, phone, googleMapsUrl, validationStatus, capturedAt',
      researchJobs:   '++id, leadId, sessionId, status, jobType, createdAt',
      researchResults:'++id, leadId, jobId, createdAt',
      deepResearch:   '++id, researchResultId, leadId, researchedAt',
      activityLogs:   '++id, sessionId, type, createdAt',
      settings:       'key',
      batchCampaigns: '++id, status, createdAt',
      existingClients:'++id, normalizedName, city, phone, normalizedPhone, uploadedAt',
    })

    this.version(7).stores({
      searchSessions: '++id, status, city, keyword, createdAt',
      leads:          '++id, sessionId, status, normalizedName, city, keyword, phone, googleMapsUrl, validationStatus, capturedAt',
      researchJobs:   '++id, leadId, sessionId, status, jobType, createdAt',
      researchResults:'++id, leadId, jobId, createdAt',
      deepResearch:   '++id, researchResultId, leadId, researchedAt',
      activityLogs:   '++id, sessionId, type, createdAt',
      settings:       'key',
      batchCampaigns: '++id, status, createdAt',
      existingClients:'++id, normalizedName, city, phone, normalizedPhone, uploadedAt',
      searchEvidence: '++id, leadId, sessionId, detectedType, capturedAt',
      sourcePages:    '++id, leadId, evidenceId, sourceType, status',
      companyResearch:'++id, leadId, createdAt',
    })

    // Version 8: drop Phase 3 tables (searchEvidence, sourcePages, companyResearch).
    // MSSQL is the sole source of truth for Phase 3 data going forward.
    // Dexie automatically deletes object stores not listed in the latest version.
    this.version(8).stores({
      searchSessions: '++id, status, city, keyword, createdAt',
      leads:          '++id, sessionId, status, normalizedName, city, keyword, phone, googleMapsUrl, validationStatus, capturedAt',
      researchJobs:   '++id, leadId, sessionId, status, jobType, createdAt',
      researchResults:'++id, leadId, jobId, createdAt',
      deepResearch:   '++id, researchResultId, leadId, researchedAt',
      activityLogs:   '++id, sessionId, type, createdAt',
      settings:       'key',
      batchCampaigns: '++id, status, createdAt',
      existingClients:'++id, normalizedName, city, phone, normalizedPhone, uploadedAt',
    })

    // Version 9: add icpScore index to leads for efficient ICP score filtering/sorting.
    // Also stores enrichment fields (teamSize, annualTurnover, industry, etc.) directly
    // on the lead row so LeadTable can display them without a secondary DB join.
    this.version(9).stores({
      searchSessions: '++id, status, city, keyword, createdAt',
      leads:          '++id, sessionId, status, normalizedName, city, keyword, phone, googleMapsUrl, validationStatus, icpScore, capturedAt',
      researchJobs:   '++id, leadId, sessionId, status, jobType, createdAt',
      researchResults:'++id, leadId, jobId, createdAt',
      deepResearch:   '++id, researchResultId, leadId, researchedAt',
      activityLogs:   '++id, sessionId, type, createdAt',
      settings:       'key',
      batchCampaigns: '++id, status, createdAt',
      existingClients:'++id, normalizedName, city, phone, normalizedPhone, uploadedAt',
    })

    // Version 10: Search Sessions ("projects") — one workspace per search run.
    // New searchProjects table + projectId index on leads so every pipeline
    // page can be scoped to a single run (schools vs pesticides never mix).
    this.version(10).stores({
      searchSessions: '++id, status, city, keyword, createdAt',
      leads:          '++id, sessionId, projectId, status, normalizedName, city, keyword, phone, googleMapsUrl, validationStatus, icpScore, capturedAt',
      researchJobs:   '++id, leadId, sessionId, status, jobType, createdAt',
      researchResults:'++id, leadId, jobId, createdAt',
      deepResearch:   '++id, researchResultId, leadId, researchedAt',
      activityLogs:   '++id, sessionId, type, createdAt',
      settings:       'key',
      batchCampaigns: '++id, status, createdAt',
      existingClients:'++id, normalizedName, city, phone, normalizedPhone, uploadedAt',
      searchProjects: '++id, status, createdAt',
    })

    // Version 11: dedicated per-stage tables. `selectedLeads` and `researchedLeads`
    // are keyed by leadId (same id as the master lead) and are MATERIALIZED from the
    // `leads` table via syncDerivedLeads(). `leads` remains the single source of
    // truth — these are rebuildable projections, so no lead data can be lost here.
    this.version(11).stores({
      searchSessions: '++id, status, city, keyword, createdAt',
      leads:          '++id, sessionId, projectId, status, normalizedName, city, keyword, phone, googleMapsUrl, validationStatus, icpScore, capturedAt',
      researchJobs:   '++id, leadId, sessionId, status, jobType, createdAt',
      researchResults:'++id, leadId, jobId, createdAt',
      deepResearch:   '++id, researchResultId, leadId, researchedAt',
      activityLogs:   '++id, sessionId, type, createdAt',
      settings:       'key',
      batchCampaigns: '++id, status, createdAt',
      existingClients:'++id, normalizedName, city, phone, normalizedPhone, uploadedAt',
      searchProjects: '++id, status, createdAt',
      selectedLeads:   'leadId, projectId, icpScore, selectedAt',
      researchedLeads: 'leadId, projectId, researchedAt',
    })

    // Version 12: redesigned schema — sessions + scraped_leads + imported_leads
    // (mirrors the new MSSQL layout). Added alongside the legacy tables so the
    // app keeps working while flows are migrated over incrementally.
    this.version(12).stores({
      searchSessions: '++id, status, city, keyword, createdAt',
      leads:          '++id, sessionId, projectId, status, normalizedName, city, keyword, phone, googleMapsUrl, validationStatus, icpScore, capturedAt',
      researchJobs:   '++id, leadId, sessionId, status, jobType, createdAt',
      researchResults:'++id, leadId, jobId, createdAt',
      deepResearch:   '++id, researchResultId, leadId, researchedAt',
      activityLogs:   '++id, sessionId, type, createdAt',
      settings:       'key',
      batchCampaigns: '++id, status, createdAt',
      existingClients:'++id, normalizedName, city, phone, normalizedPhone, uploadedAt',
      searchProjects: '++id, status, createdAt',
      selectedLeads:   'leadId, projectId, icpScore, selectedAt',
      researchedLeads: 'leadId, projectId, researchedAt',
      // New redesigned tables
      sessions:       '++id, mssqlId, source, status, createdAt',
      scrapedLeads:   '++id, mssqlId, sessionId, status, normalizedName, validationStatus, researchStatus, icpScore, capturedAt',
      importedLeads:  '++id, mssqlId, sessionId, status, normalizedName, validationStatus, researchStatus, icpScore, capturedAt',
    })
  }
}

export const db = new LeadScoutDB()
