import { db } from './db'
import type { SearchProject, SearchProjectStatus } from '@/types/searchProject'
import { nowISO } from '@/utils/date'

export const searchProjectRepository = {
  async create(project: Omit<SearchProject, 'id' | 'createdAt'>): Promise<number> {
    return db.searchProjects.add({ ...project, createdAt: nowISO() } as SearchProject)
  },

  async getById(id: number): Promise<SearchProject | undefined> {
    return db.searchProjects.get(id)
  },

  async getAll(): Promise<SearchProject[]> {
    return db.searchProjects.orderBy('createdAt').reverse().toArray()
  },

  async update(id: number, patch: Partial<SearchProject>): Promise<void> {
    await db.searchProjects.update(id, patch)
  },

  async rename(id: number, name: string): Promise<void> {
    await db.searchProjects.update(id, { name })
  },

  async setStatus(id: number, status: SearchProjectStatus): Promise<void> {
    const patch: Partial<SearchProject> = { status }
    if (status !== 'running') patch.completedAt = nowISO()
    await db.searchProjects.update(id, patch)
  },

  // Called after each term of the run finishes.
  async recordTermCompleted(id: number, leadsCaptured: number): Promise<void> {
    const p = await db.searchProjects.get(id)
    if (!p) return
    await db.searchProjects.update(id, {
      completedTerms: p.completedTerms + 1,
      totalLeads: p.totalLeads + leadsCaptured,
    })
  },

  // Deleting a project keeps its leads — they become "Unassigned" rather than
  // destroying capture data (leads are never deleted implicitly).
  async delete(id: number): Promise<void> {
    await db.leads.where('projectId').equals(id).modify((l) => { delete (l as any).projectId })
    await db.searchProjects.delete(id)
  },
}
