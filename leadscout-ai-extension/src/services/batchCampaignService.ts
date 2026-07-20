import { db } from '@/db/db'
import type { BatchCampaign } from '@/types/batchCampaign'
import { nowISO } from '@/utils/date'

export async function createCampaign(
  opts: Pick<BatchCampaign, 'keyword' | 'cities' | 'country' | 'autoResearch'>
): Promise<number> {
  const id = await db.batchCampaigns.add({
    ...opts,
    status: 'pending',
    currentCityIndex: 0,
    totalCaptured: 0,
    createdAt: nowISO(),
  })
  return id as number
}

export async function getCampaign(id: number): Promise<BatchCampaign | undefined> {
  return db.batchCampaigns.get(id)
}

export async function updateCampaign(id: number, patch: Partial<BatchCampaign>): Promise<void> {
  await db.batchCampaigns.update(id, patch)
}

export async function getAllCampaigns(): Promise<BatchCampaign[]> {
  const all = await db.batchCampaigns.toArray()
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function deleteCampaign(id: number): Promise<void> {
  await db.batchCampaigns.delete(id)
}
