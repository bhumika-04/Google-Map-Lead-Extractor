import Dexie, { type Table } from 'dexie'
import type { Lead } from '@/types/lead'
import type { SearchSession } from '@/types/searchSession'
import type { ResearchJob, ResearchResult } from '@/types/research'
import type { DeepResearch } from '@/types/deepResearch'

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
  }
}

export const db = new LeadScoutDB()
