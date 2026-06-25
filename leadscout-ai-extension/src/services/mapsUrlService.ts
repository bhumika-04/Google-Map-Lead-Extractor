export function buildMapsSearchUrl(keyword: string, city: string): string {
  const query = encodeURIComponent(`${keyword} in ${city}`)
  return `https://www.google.com/maps/search/${query}`
}

export function buildGeneratedQuery(keyword: string, city: string): string {
  return `${keyword} in ${city}`
}
