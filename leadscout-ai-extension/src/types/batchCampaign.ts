export interface BatchCampaignCity {
  city: string
  /** ISO country code for THIS city — lets one campaign span multiple countries.
   *  Falls back to the campaign-level `country` when absent (older records). */
  country?: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  capturedCount: number
  startedAt?: string
  completedAt?: string
}

export interface BatchCampaign {
  id?: number
  keyword: string
  cities: BatchCampaignCity[]
  /** ISO country code — stamped on every lead captured by this campaign */
  country: string
  autoResearch: boolean
  status: 'pending' | 'running' | 'completed' | 'stopped'
  currentCityIndex: number
  totalCaptured: number
  /** Search Session (searchProjects.id) created for this campaign — set at start */
  projectId?: number
  createdAt: string
  completedAt?: string
}
