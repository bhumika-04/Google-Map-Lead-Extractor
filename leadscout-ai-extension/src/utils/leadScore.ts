import type { Lead } from '@/types/lead'

export function calculateLeadScore(lead: Lead): number {
  let score = 0
  if (lead.phone)    score += 25
  if (lead.website)  score += 20
  if (lead.rating != null) {
    if (lead.rating >= 4.5) score += 20
    else if (lead.rating >= 4.0) score += 14
    else if (lead.rating >= 3.0) score += 7
  }
  if (lead.reviewCount != null) {
    if (lead.reviewCount >= 500)      score += 15
    else if (lead.reviewCount >= 100) score += 10
    else if (lead.reviewCount >= 10)  score += 5
  }
  if (lead.address) score += 10
  return Math.min(100, score)
}

export function scoreLabel(score: number): string {
  if (score >= 80) return 'Hot'
  if (score >= 55) return 'Good'
  if (score >= 30) return 'Fair'
  return 'Weak'
}

export function scoreColor(score: number): string {
  if (score >= 80) return 'text-green-400 bg-green-950 border-green-800'
  if (score >= 55) return 'text-blue-400 bg-blue-950 border-blue-800'
  if (score >= 30) return 'text-yellow-400 bg-yellow-950 border-yellow-800'
  return 'text-gray-500 bg-gray-800 border-gray-700'
}
