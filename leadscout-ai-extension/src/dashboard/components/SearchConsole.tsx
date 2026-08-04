import React, { useState, useEffect, useRef, useCallback } from 'react'
import { MSG } from '@/types/messages'
import type { SearchQueueStartPayload, SearchQueueProgress, ProgressUpdatePayload } from '@/types/messages'
import { useSettingsStore } from '@/state/useSettingsStore'
import { useCaptureStore } from '@/state/useCaptureStore'
import { toast } from '@/state/useToastStore'
import { translateKeyword } from '@/services/queryLocalizer'
import { searchProjectRepository } from '@/db/searchProjectRepository'
import { resolveAiCredentials } from '@/services/sqlSyncService'
import { getCountryIntelligence } from '@/config/countryIntelligence'
import { fetchTopCities, fetchKeywordSynonyms } from '@/services/cityService'
import SearchPresets from './SearchPresets'

// Local-language Maps keyword (e.g. "printing press" → "مطبعة" for Oman) —
// null when the country is English-primary or no translation is known.
function getLocalKeyword(keyword: string, countryCode: string): string | null {
  const intel = getCountryIntelligence(countryCode)
  if (!intel.localLanguage) return null
  return translateKeyword(keyword, intel.localLanguage)
}

// ─── Country list (ISO 3166-1 alpha-2) ───────────────────────────────────────
// flag/COUNTRIES/COUNTRY_CITIES are exported for reuse by BatchCampaignPanel
// (country picker) and MarketsPage (grouping + country inference backfill).
export function flag(code: string): string {
  return code.toUpperCase().replace(/./g, c => String.fromCodePoint(c.charCodeAt(0) + 127397))
}

export const COUNTRIES: { code: string; name: string }[] = [
  { code: 'AF', name: 'Afghanistan' }, { code: 'AL', name: 'Albania' }, { code: 'DZ', name: 'Algeria' },
  { code: 'AD', name: 'Andorra' }, { code: 'AO', name: 'Angola' }, { code: 'AG', name: 'Antigua and Barbuda' },
  { code: 'AR', name: 'Argentina' }, { code: 'AM', name: 'Armenia' }, { code: 'AU', name: 'Australia' },
  { code: 'AT', name: 'Austria' }, { code: 'AZ', name: 'Azerbaijan' }, { code: 'BS', name: 'Bahamas' },
  { code: 'BH', name: 'Bahrain' }, { code: 'BD', name: 'Bangladesh' }, { code: 'BB', name: 'Barbados' },
  { code: 'BY', name: 'Belarus' }, { code: 'BE', name: 'Belgium' }, { code: 'BZ', name: 'Belize' },
  { code: 'BJ', name: 'Benin' }, { code: 'BT', name: 'Bhutan' }, { code: 'BO', name: 'Bolivia' },
  { code: 'BA', name: 'Bosnia and Herzegovina' }, { code: 'BW', name: 'Botswana' }, { code: 'BR', name: 'Brazil' },
  { code: 'BN', name: 'Brunei' }, { code: 'BG', name: 'Bulgaria' }, { code: 'BF', name: 'Burkina Faso' },
  { code: 'BI', name: 'Burundi' }, { code: 'CV', name: 'Cape Verde' }, { code: 'KH', name: 'Cambodia' },
  { code: 'CM', name: 'Cameroon' }, { code: 'CA', name: 'Canada' }, { code: 'CF', name: 'Central African Republic' },
  { code: 'TD', name: 'Chad' }, { code: 'CL', name: 'Chile' }, { code: 'CN', name: 'China' },
  { code: 'CO', name: 'Colombia' }, { code: 'KM', name: 'Comoros' }, { code: 'CG', name: 'Congo' },
  { code: 'CR', name: 'Costa Rica' }, { code: 'HR', name: 'Croatia' }, { code: 'CU', name: 'Cuba' },
  { code: 'CY', name: 'Cyprus' }, { code: 'CZ', name: 'Czech Republic' }, { code: 'DK', name: 'Denmark' },
  { code: 'DJ', name: 'Djibouti' }, { code: 'DO', name: 'Dominican Republic' }, { code: 'EC', name: 'Ecuador' },
  { code: 'EG', name: 'Egypt' }, { code: 'SV', name: 'El Salvador' }, { code: 'GQ', name: 'Equatorial Guinea' },
  { code: 'ER', name: 'Eritrea' }, { code: 'EE', name: 'Estonia' }, { code: 'ET', name: 'Ethiopia' },
  { code: 'FJ', name: 'Fiji' }, { code: 'FI', name: 'Finland' }, { code: 'FR', name: 'France' },
  { code: 'GA', name: 'Gabon' }, { code: 'GM', name: 'Gambia' }, { code: 'GE', name: 'Georgia' },
  { code: 'DE', name: 'Germany' }, { code: 'GH', name: 'Ghana' }, { code: 'GR', name: 'Greece' },
  { code: 'GT', name: 'Guatemala' }, { code: 'GN', name: 'Guinea' }, { code: 'GW', name: 'Guinea-Bissau' },
  { code: 'GY', name: 'Guyana' }, { code: 'HT', name: 'Haiti' }, { code: 'HN', name: 'Honduras' },
  { code: 'HU', name: 'Hungary' }, { code: 'IS', name: 'Iceland' }, { code: 'IN', name: 'India' },
  { code: 'ID', name: 'Indonesia' }, { code: 'IR', name: 'Iran' }, { code: 'IQ', name: 'Iraq' },
  { code: 'IE', name: 'Ireland' }, { code: 'IL', name: 'Israel' }, { code: 'IT', name: 'Italy' },
  { code: 'JM', name: 'Jamaica' }, { code: 'JP', name: 'Japan' }, { code: 'JO', name: 'Jordan' },
  { code: 'KZ', name: 'Kazakhstan' }, { code: 'KE', name: 'Kenya' }, { code: 'KI', name: 'Kiribati' },
  { code: 'KP', name: 'North Korea' }, { code: 'KR', name: 'South Korea' }, { code: 'KW', name: 'Kuwait' },
  { code: 'KG', name: 'Kyrgyzstan' }, { code: 'LA', name: 'Laos' }, { code: 'LV', name: 'Latvia' },
  { code: 'LB', name: 'Lebanon' }, { code: 'LS', name: 'Lesotho' }, { code: 'LR', name: 'Liberia' },
  { code: 'LY', name: 'Libya' }, { code: 'LI', name: 'Liechtenstein' }, { code: 'LT', name: 'Lithuania' },
  { code: 'LU', name: 'Luxembourg' }, { code: 'MG', name: 'Madagascar' }, { code: 'MW', name: 'Malawi' },
  { code: 'MY', name: 'Malaysia' }, { code: 'MV', name: 'Maldives' }, { code: 'ML', name: 'Mali' },
  { code: 'MT', name: 'Malta' }, { code: 'MH', name: 'Marshall Islands' }, { code: 'MR', name: 'Mauritania' },
  { code: 'MU', name: 'Mauritius' }, { code: 'MX', name: 'Mexico' }, { code: 'FM', name: 'Micronesia' },
  { code: 'MD', name: 'Moldova' }, { code: 'MC', name: 'Monaco' }, { code: 'MN', name: 'Mongolia' },
  { code: 'ME', name: 'Montenegro' }, { code: 'MA', name: 'Morocco' }, { code: 'MZ', name: 'Mozambique' },
  { code: 'MM', name: 'Myanmar' }, { code: 'NA', name: 'Namibia' }, { code: 'NR', name: 'Nauru' },
  { code: 'NP', name: 'Nepal' }, { code: 'NL', name: 'Netherlands' }, { code: 'NZ', name: 'New Zealand' },
  { code: 'NI', name: 'Nicaragua' }, { code: 'NE', name: 'Niger' }, { code: 'NG', name: 'Nigeria' },
  { code: 'NO', name: 'Norway' }, { code: 'OM', name: 'Oman' }, { code: 'PK', name: 'Pakistan' },
  { code: 'PW', name: 'Palau' }, { code: 'PA', name: 'Panama' }, { code: 'PG', name: 'Papua New Guinea' },
  { code: 'PY', name: 'Paraguay' }, { code: 'PE', name: 'Peru' }, { code: 'PH', name: 'Philippines' },
  { code: 'PL', name: 'Poland' }, { code: 'PT', name: 'Portugal' }, { code: 'QA', name: 'Qatar' },
  { code: 'RO', name: 'Romania' }, { code: 'RU', name: 'Russia' }, { code: 'RW', name: 'Rwanda' },
  { code: 'KN', name: 'Saint Kitts and Nevis' }, { code: 'LC', name: 'Saint Lucia' },
  { code: 'VC', name: 'Saint Vincent and the Grenadines' }, { code: 'WS', name: 'Samoa' },
  { code: 'SM', name: 'San Marino' }, { code: 'ST', name: 'Sao Tome and Principe' },
  { code: 'SA', name: 'Saudi Arabia' }, { code: 'SN', name: 'Senegal' }, { code: 'RS', name: 'Serbia' },
  { code: 'SC', name: 'Seychelles' }, { code: 'SL', name: 'Sierra Leone' }, { code: 'SG', name: 'Singapore' },
  { code: 'SK', name: 'Slovakia' }, { code: 'SI', name: 'Slovenia' }, { code: 'SB', name: 'Solomon Islands' },
  { code: 'SO', name: 'Somalia' }, { code: 'ZA', name: 'South Africa' }, { code: 'SS', name: 'South Sudan' },
  { code: 'ES', name: 'Spain' }, { code: 'LK', name: 'Sri Lanka' }, { code: 'SD', name: 'Sudan' },
  { code: 'SR', name: 'Suriname' }, { code: 'SE', name: 'Sweden' }, { code: 'CH', name: 'Switzerland' },
  { code: 'SY', name: 'Syria' }, { code: 'TW', name: 'Taiwan' }, { code: 'TJ', name: 'Tajikistan' },
  { code: 'TZ', name: 'Tanzania' }, { code: 'TH', name: 'Thailand' }, { code: 'TL', name: 'Timor-Leste' },
  { code: 'TG', name: 'Togo' }, { code: 'TO', name: 'Tonga' }, { code: 'TT', name: 'Trinidad and Tobago' },
  { code: 'TN', name: 'Tunisia' }, { code: 'TR', name: 'Turkey' }, { code: 'TM', name: 'Turkmenistan' },
  { code: 'TV', name: 'Tuvalu' }, { code: 'UG', name: 'Uganda' }, { code: 'UA', name: 'Ukraine' },
  { code: 'AE', name: 'UAE' }, { code: 'GB', name: 'United Kingdom' }, { code: 'US', name: 'United States' },
  { code: 'UY', name: 'Uruguay' }, { code: 'UZ', name: 'Uzbekistan' }, { code: 'VU', name: 'Vanuatu' },
  { code: 'VE', name: 'Venezuela' }, { code: 'VN', name: 'Vietnam' }, { code: 'YE', name: 'Yemen' },
  { code: 'ZM', name: 'Zambia' }, { code: 'ZW', name: 'Zimbabwe' },
]

// ─── City lists per country ───────────────────────────────────────────────────
export const COUNTRY_CITIES: Record<string, string[]> = {
  IN: [
    'Mumbai', 'Delhi', 'Bangalore', 'Chennai', 'Kolkata', 'Hyderabad', 'Pune', 'Ahmedabad', 'Surat', 'Jaipur',
    'Lucknow', 'Kanpur', 'Nagpur', 'Indore', 'Bhopal', 'Patna', 'Vadodara', 'Ludhiana', 'Coimbatore', 'Kochi',
    'Agra', 'Nashik', 'Faridabad', 'Meerut', 'Rajkot', 'Varanasi', 'Aurangabad', 'Amritsar', 'Vijayawada', 'Jodhpur',
    'Ranchi', 'Guwahati', 'Chandigarh', 'Mysuru', 'Bhubaneswar', 'Noida', 'Gurgaon', 'Thane', 'Visakhapatnam', 'Srinagar',
    'Hubli', 'Tiruchirappalli', 'Jabalpur', 'Madurai', 'Thiruvananthapuram', 'Raipur', 'Kota', 'Gwalior', 'Navi Mumbai', 'Dhanbad',
    'Prayagraj', 'Howrah', 'Jalandhar', 'Bareilly', 'Moradabad', 'Aligarh', 'Gorakhpur', 'Saharanpur', 'Guntur', 'Bikaner',
    'Amravati', 'Bhilai', 'Warangal', 'Cuttack', 'Firozabad', 'Nellore', 'Bhavnagar', 'Durgapur', 'Asansol', 'Nanded',
    'Kolhapur', 'Ajmer', 'Akola', 'Jamnagar', 'Ujjain', 'Siliguri', 'Jhansi', 'Mangalore', 'Belgaum', 'Tirunelveli',
    'Gaya', 'Jalgaon', 'Udaipur', 'Tirupur', 'Davanagere', 'Kozhikode', 'Kurnool', 'Bokaro', 'Bellary', 'Patiala',
    'Agartala', 'Bhagalpur', 'Muzaffarnagar', 'Latur', 'Dhule', 'Rohtak', 'Korba', 'Bhilwara', 'Berhampur', 'Muzaffarpur',
    'Ahmednagar', 'Mathura', 'Kollam', 'Kadapa', 'Sambalpur', 'Bilaspur', 'Shahjahanpur', 'Satara', 'Vijayapura', 'Rampur',
    'Shivamogga', 'Chandrapur', 'Junagadh', 'Thrissur', 'Alwar', 'Bardhaman', 'Nizamabad', 'Parbhani', 'Tumakuru', 'Khammam',
    'Panipat', 'Darbhanga', 'Aizawl', 'Dewas', 'Ichalkaranji', 'Karnal', 'Bathinda', 'Jalna', 'Eluru', 'Barasat',
    'Purnia', 'Satna', 'Sonipat', 'Farrukhabad', 'Sagar', 'Rourkela', 'Durg', 'Imphal', 'Ratlam', 'Hapur',
    'Anantapur', 'Karimnagar', 'Etawah', 'Ambernath', 'Bharatpur', 'Begusarai', 'Gandhidham', 'Puducherry', 'Sikar', 'Thoothukudi',
    'Rewa', 'Mirzapur', 'Raichur', 'Pali', 'Ramagundam', 'Haridwar', 'Vellore', 'Salem', 'Erode', 'Dehradun',
    'Gandhinagar', 'Anand', 'Nadiad', 'Morbi', 'Mehsana', 'Surendranagar', 'Vapi', 'Navsari', 'Bharuch', 'Porbandar',
    'Karur', 'Thanjavur', 'Dindigul', 'Hosur', 'Cuddalore', 'Kumbakonam', 'Nagercoil', 'Kanchipuram', 'Karaikudi', 'Neyveli',
    'Kakinada', 'Rajahmundry', 'Tirupati', 'Ongole', 'Chittoor', 'Vizianagaram', 'Tenali', 'Proddatur', 'Machilipatnam', 'Adoni',
    'Palakkad', 'Kannur', 'Kottayam', 'Alappuzha', 'Malappuram', 'Bidar', 'Hospet', 'Hassan', 'Gadag', 'Chikmagalur',
  ],
  AE: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain', 'Al Ain'],
  SA: ['Riyadh', 'Jeddah', 'Mecca', 'Medina', 'Dammam', 'Al Khobar', 'Tabuk', 'Abha', 'Buraidah', 'Khamis Mushait', 'Al Ahsa', 'Yanbu', 'Jizan', 'Najran', 'Hail'],
  PK: ['Karachi', 'Lahore', 'Islamabad', 'Faisalabad', 'Rawalpindi', 'Multan', 'Gujranwala', 'Hyderabad', 'Peshawar', 'Quetta', 'Sialkot', 'Bahawalpur', 'Sargodha', 'Gujrat', 'Sheikhupura', 'Sukkur', 'Larkana', 'Jhang', 'Rahim Yar Khan', 'Mardan'],
  QA: ['Doha', 'Al Wakrah', 'Al Khor', 'Umm Salal', 'Lusail', 'Al Rayyan', 'Dukhan'],
  KW: ['Kuwait City', 'Hawalli', 'Salmiya', 'Farwaniya', 'Jahra', 'Ahmadi', 'Rumaithiya'],
  BH: ['Manama', 'Riffa', 'Muharraq', 'Hamad Town', 'Isa Town', 'Sitra', 'Budaiya'],
  OM: ['Muscat', 'Salalah', 'Sohar', 'Nizwa', 'Sur', 'Ibri', 'Buraimi', 'Saham', 'Al Buraymi', 'Seeb'],
  EG: ['Cairo', 'Alexandria', 'Giza', 'Port Said', 'Suez', 'Luxor', 'Asyut', 'Mansoura', 'Tanta', 'El Mahalla El Kubra', 'Ismailia', 'Faiyum', 'Damanhur', 'Minya', 'Sohag'],
  GB: ['London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow', 'Sheffield', 'Edinburgh', 'Liverpool', 'Bristol', 'Cardiff', 'Leicester', 'Coventry', 'Nottingham', 'Bradford', 'Belfast', 'Newcastle', 'Wolverhampton', 'Southampton', 'Portsmouth', 'Reading'],
  US: ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'San Jose', 'Austin', 'Jacksonville', 'Fort Worth', 'Columbus', 'Charlotte', 'Indianapolis', 'San Francisco', 'Seattle', 'Denver', 'Boston', 'Atlanta', 'Miami', 'Las Vegas', 'Detroit', 'Nashville', 'Portland', 'Memphis', 'Louisville', 'Baltimore', 'Milwaukee'],
  AU: ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide', 'Canberra', 'Gold Coast', 'Newcastle', 'Wollongong', 'Sunshine Coast', 'Hobart', 'Darwin'],
  CA: ['Toronto', 'Montreal', 'Vancouver', 'Calgary', 'Edmonton', 'Ottawa', 'Winnipeg', 'Quebec City', 'Hamilton', 'Brampton', 'Mississauga', 'Kitchener', 'Halifax'],
  DE: ['Berlin', 'Hamburg', 'Munich', 'Cologne', 'Frankfurt', 'Stuttgart', 'Düsseldorf', 'Dortmund', 'Essen', 'Leipzig', 'Bremen', 'Dresden', 'Hanover', 'Nuremberg', 'Duisburg'],
  FR: ['Paris', 'Lyon', 'Marseille', 'Toulouse', 'Nice', 'Nantes', 'Strasbourg', 'Montpellier', 'Bordeaux', 'Lille', 'Rennes', 'Reims', 'Toulon', 'Grenoble'],
  IT: ['Rome', 'Milan', 'Naples', 'Turin', 'Palermo', 'Genoa', 'Bologna', 'Florence', 'Venice', 'Verona', 'Catania', 'Bari'],
  ES: ['Madrid', 'Barcelona', 'Valencia', 'Seville', 'Zaragoza', 'Málaga', 'Murcia', 'Palma', 'Las Palmas', 'Bilbao', 'Alicante', 'Córdoba'],
  SG: ['Singapore'],
  MY: ['Kuala Lumpur', 'Petaling Jaya', 'George Town', 'Johor Bahru', 'Ipoh', 'Shah Alam', 'Subang Jaya', 'Klang', 'Malacca', 'Kota Kinabalu', 'Kuching', 'Seremban'],
  BD: ['Dhaka', 'Chittagong', 'Sylhet', 'Rajshahi', 'Khulna', 'Comilla', 'Narayanganj', 'Gazipur', 'Mymensingh'],
  LK: ['Colombo', 'Kandy', 'Galle', 'Jaffna', 'Negombo', 'Trincomalee', 'Batticaloa', 'Anuradhapura'],
  NG: ['Lagos', 'Kano', 'Ibadan', 'Kaduna', 'Port Harcourt', 'Benin City', 'Maiduguri', 'Zaria', 'Aba', 'Abuja', 'Enugu', 'Onitsha', 'Owerri'],
  ZA: ['Johannesburg', 'Cape Town', 'Durban', 'Pretoria', 'Port Elizabeth', 'Bloemfontein', 'East London', 'Kimberley', 'Nelspruit', 'Polokwane'],
  KE: ['Nairobi', 'Mombasa', 'Kisumu', 'Nakuru', 'Eldoret', 'Thika', 'Nyeri', 'Garissa'],
  MA: ['Casablanca', 'Rabat', 'Marrakech', 'Fez', 'Tangier', 'Agadir', 'Oujda', 'Kenitra', 'Meknes', 'Tetouan'],
  TR: ['Istanbul', 'Ankara', 'Izmir', 'Bursa', 'Adana', 'Gaziantep', 'Konya', 'Antalya', 'Kayseri', 'Mersin', 'Eskisehir', 'Diyarbakir', 'Samsun'],
  ID: ['Jakarta', 'Surabaya', 'Bandung', 'Medan', 'Semarang', 'Makassar', 'Palembang', 'Tangerang', 'Bekasi', 'Depok', 'Batam', 'Pekanbaru', 'Denpasar'],
  PH: ['Manila', 'Quezon City', 'Cebu', 'Davao', 'Antipolo', 'Taguig', 'Pasig', 'Cagayan de Oro', 'Zamboanga', 'Valenzuela'],
  TH: ['Bangkok', 'Chiang Mai', 'Pattaya', 'Khon Kaen', 'Hat Yai', 'Nonthaburi', 'Pak Kret', 'Udon Thani', 'Chon Buri'],
  VN: ['Ho Chi Minh City', 'Hanoi', 'Da Nang', 'Hai Phong', 'Can Tho', 'Bien Hoa', 'Hue', 'Nha Trang', 'Vung Tau'],
  JP: ['Tokyo', 'Osaka', 'Yokohama', 'Nagoya', 'Sapporo', 'Fukuoka', 'Kobe', 'Kyoto', 'Kawasaki', 'Hiroshima', 'Sendai', 'Chiba'],
  KR: ['Seoul', 'Busan', 'Incheon', 'Daegu', 'Daejeon', 'Gwangju', 'Suwon', 'Ulsan', 'Goyang', 'Seongnam'],
  CN: ['Beijing', 'Shanghai', 'Guangzhou', 'Shenzhen', 'Chengdu', 'Tianjin', 'Wuhan', 'Dongguan', 'Chongqing', 'Nanjing', 'Hangzhou', "Xi'an", 'Suzhou', 'Zhengzhou', 'Qingdao', 'Foshan'],
  BR: ['São Paulo', 'Rio de Janeiro', 'Brasília', 'Salvador', 'Fortaleza', 'Belo Horizonte', 'Manaus', 'Curitiba', 'Recife', 'Porto Alegre', 'Belém', 'Goiânia'],
  MX: ['Mexico City', 'Guadalajara', 'Monterrey', 'Puebla', 'Tijuana', 'León', 'Ciudad Juárez', 'Toluca', 'Chihuahua', 'Culiacán', 'Mérida', 'Querétaro'],
  RU: ['Moscow', 'Saint Petersburg', 'Novosibirsk', 'Yekaterinburg', 'Kazan', 'Nizhny Novgorod', 'Chelyabinsk', 'Samara', 'Ufa', 'Rostov-on-Don', 'Krasnoyarsk', 'Omsk'],
  IQ: ['Baghdad', 'Basra', 'Mosul', 'Erbil', 'Kirkuk', 'Najaf', 'Karbala', 'Sulaymaniyah'],
  IR: ['Tehran', 'Mashhad', 'Isfahan', 'Karaj', 'Tabriz', 'Shiraz', 'Ahvaz', 'Qom', 'Kermanshah', 'Rasht'],
  JO: ['Amman', 'Zarqa', 'Irbid', 'Russeifa', 'Aqaba', 'Salt', 'Madaba'],
  LB: ['Beirut', 'Tripoli', 'Sidon', 'Tyre', 'Jounieh', 'Zahle'],
  TN: ['Tunis', 'Sfax', 'Sousse', 'Kairouan', 'Bizerte', 'Gabes', 'Aryanah'],
  GH: ['Accra', 'Kumasi', 'Tamale', 'Cape Coast', 'Obuasi', 'Tema'],
  ET: ['Addis Ababa', 'Dire Dawa', 'Mekelle', 'Gondar', 'Hawassa', 'Bahir Dar'],
  TZ: ['Dar es Salaam', 'Mwanza', 'Arusha', 'Dodoma', 'Zanzibar', 'Moshi'],
  NP: ['Kathmandu', 'Pokhara', 'Lalitpur', 'Biratnagar', 'Bharatpur', 'Birgunj'],
  NL: ['Amsterdam', 'Rotterdam', 'The Hague', 'Utrecht', 'Eindhoven', 'Tilburg', 'Groningen', 'Breda'],
  PL: ['Warsaw', 'Kraków', 'Lodz', 'Wroclaw', 'Poznan', 'Gdansk', 'Szczecin', 'Bydgoszcz', 'Lublin'],
  UA: ['Kyiv', 'Kharkiv', 'Odessa', 'Dnipro', 'Zaporizhzhia', 'Lviv', 'Kryvyi Rih', 'Mykolaiv'],
  SY: ['Damascus', 'Aleppo', 'Homs', 'Latakia', 'Deir ez-Zor', 'Tartus'],
  IL: ['Tel Aviv', 'Jerusalem', 'Haifa', 'Rishon LeZion', 'Petah Tikva', 'Ashdod', 'Netanya', 'Beer Sheva'],
  GR: ['Athens', 'Thessaloniki', 'Patras', 'Heraklion', 'Larissa', 'Volos'],
  PT: ['Lisbon', 'Porto', 'Braga', 'Amadora', 'Setúbal', 'Coimbra', 'Funchal'],
  SE: ['Stockholm', 'Gothenburg', 'Malmö', 'Uppsala', 'Linköping', 'Västerås'],
  NO: ['Oslo', 'Bergen', 'Trondheim', 'Stavanger', 'Drammen', 'Fredrikstad'],
  DK: ['Copenhagen', 'Aarhus', 'Odense', 'Aalborg', 'Esbjerg', 'Randers'],
  FI: ['Helsinki', 'Espoo', 'Tampere', 'Vantaa', 'Oulu', 'Turku'],
  ZW: ['Harare', 'Bulawayo', 'Chitungwiza', 'Mutare', 'Gweru'],
  UG: ['Kampala', 'Gulu', 'Mbarara', 'Jinja', 'Entebbe'],
  SN: ['Dakar', 'Touba', 'Thiès', 'Kaolack', 'Saint-Louis'],
}

// ─── Synonym / related-terms map ─────────────────────────────────────────────
const SYNONYM_MAP: Record<string, string[]> = {
  'printing':          ['Offset Printing', 'Digital Printing', 'Screen Printing', 'Flex Printing', 'Book Printing', 'Label Printing'],
  'print':             ['Offset Printing', 'Digital Printing', 'Screen Printing', 'Flex Printing'],
  'packaging':         ['Packaging Manufacturer', 'Carton Manufacturer', 'Box Manufacturer', 'Corrugated Box', 'Plastic Packaging'],
  'pharma':            ['Pharmaceutical Manufacturer', 'Medicine Manufacturer', 'Drug Company', 'API Manufacturer'],
  'pharmaceutical':    ['Pharma Manufacturer', 'Medicine Manufacturer', 'Drug Company', 'API Manufacturer'],
  'textile':           ['Fabric Manufacturer', 'Garment Manufacturer', 'Clothing Manufacturer', 'Yarn Manufacturer'],
  'garment':           ['Clothing Manufacturer', 'Textile Manufacturer', 'Apparel Manufacturer', 'Fabric Supplier'],
  'ca':                ['Chartered Accountant', 'Tax Consultant', 'GST Consultant', 'Audit Firm', 'Accounting Firm'],
  'chartered':         ['CA Firm', 'Tax Consultant', 'GST Consultant', 'Audit Firm'],
  'it company':        ['Software Company', 'Web Development', 'App Development', 'IT Services'],
  'software':          ['IT Company', 'Web Development', 'App Development', 'Digital Agency'],
  'hospital':          ['Clinic', 'Nursing Home', 'Diagnostic Centre', 'Pathology Lab', 'Medical Centre'],
  'clinic':            ['Hospital', 'Nursing Home', 'Diagnostic Centre', 'Medical Centre'],
  'dentist':           ['Dental Clinic', 'Dental Hospital', 'Orthodontist', 'Dental Care'],
  'dental':            ['Dentist', 'Dental Hospital', 'Orthodontist'],
  'restaurant':        ['Hotel', 'Dhaba', 'Food Court', 'Tiffin Service', 'Cafe', 'Bakery'],
  'hotel':             ['Restaurant', 'Dhaba', 'Resort', 'Lodge', 'Guest House'],
  'real estate':       ['Property Dealer', 'Builder', 'Developer', 'Construction Company', 'Land Dealer'],
  'builder':           ['Real Estate Developer', 'Construction Company', 'Contractor', 'Property Developer'],
  'lawyer':            ['Advocate', 'Law Firm', 'Legal Services', 'Legal Consultant'],
  'advocate':          ['Lawyer', 'Law Firm', 'Legal Services'],
  'transport':         ['Logistics', 'Courier Service', 'Cargo', 'Freight', 'Packers and Movers'],
  'logistics':         ['Transport', 'Courier Service', 'Cargo', 'Freight', 'Supply Chain'],
  'steel':             ['Iron Manufacturer', 'Metal Fabrication', 'Steel Supplier', 'Metal Works'],
  'plastic':           ['Plastic Manufacturer', 'Injection Moulding', 'Polymer Products', 'PVC Products'],
  'electrical':        ['Electrician', 'Electrical Contractor', 'Panel Manufacturer', 'Wiring'],
  'furniture':         ['Interior Designer', 'Wood Work', 'Modular Furniture', 'Office Furniture'],
  'construction':      ['Builder', 'Contractor', 'Civil Contractor', 'Infrastructure'],
  'school':            ['Coaching Centre', 'Tuition', 'Academy', 'Institute', 'College'],
  'education':         ['School', 'College', 'Coaching Centre', 'Academy', 'Institute'],
  'food':              ['Food Processing', 'Food Manufacturer', 'Bakery', 'Catering'],
  'chemical':          ['Chemical Manufacturer', 'Specialty Chemical', 'Agrochemical', 'Industrial Chemical'],
  'engineering':       ['Fabrication', 'Machine Parts', 'CNC Machining', 'Tooling', 'Sheet Metal'],
}

function getSuggestions(keyword: string): string[] {
  if (!keyword.trim()) return []
  const lower = keyword.toLowerCase().trim()
  for (const [key, terms] of Object.entries(SYNONYM_MAP)) {
    if (lower === key || lower.includes(key) || key.includes(lower)) return terms
  }
  return []
}

// ─── City multi-select component ─────────────────────────────────────────────
interface CityMultiSelectProps {
  selected: string[]
  onChange: (cities: string[]) => void
  country: string
  disabled?: boolean
}

export function CityMultiSelect({ selected, onChange, country, disabled }: CityMultiSelectProps) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const countryCities = COUNTRY_CITIES[country] ?? []
  const filtered = countryCities.filter(
    (c) => c.toLowerCase().includes(search.toLowerCase()) && !selected.includes(c)
  )

  // Add custom city on Enter or comma
  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { setOpen(false); setSearch(''); return }
    if ((e.key === 'Enter' || e.key === ',') && search.trim()) {
      e.preventDefault()
      const val = search.replace(',', '').trim()
      if (val && !selected.includes(val)) onChange([...selected, val])
      setSearch('')
      return
    }
    if (e.key === 'Backspace' && !search && selected.length > 0) {
      onChange(selected.slice(0, -1))
    }
  }

  function toggleCity(city: string) {
    if (selected.includes(city)) {
      onChange(selected.filter((c) => c !== city))
    } else {
      onChange([...selected, city])
      setSearch('')
    }
    inputRef.current?.focus()
  }

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  const showDropdown = open && (filtered.length > 0 || (search.trim().length > 0 && !selected.includes(search.trim())))

  return (
    <div ref={containerRef} className="relative">
      {/* Input box — chips + text input */}
      <div
        onClick={() => { if (!disabled) { setOpen(true); inputRef.current?.focus() } }}
        className={`min-h-[38px] w-full bg-gray-800 border rounded-lg px-2 py-1.5 flex flex-wrap gap-1.5 items-center cursor-text transition-colors
          ${open ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-700 hover:border-gray-600'}
          ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
      >
        {/* Selected city chips */}
        {selected.map((city) => (
          <span
            key={city}
            className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 text-blue-50 text-xs rounded-md shrink-0 animate-pop-in
              bg-gradient-to-r from-blue-600/50 to-indigo-600/50 border border-blue-500/40"
          >
            {city}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onChange(selected.filter((c) => c !== city)) }}
              className="text-blue-300 hover:text-white ml-0.5 leading-none transition-colors"
            >
              ×
            </button>
          </span>
        ))}

        {/* Text input */}
        <input
          ref={inputRef}
          type="text"
          value={search}
          disabled={disabled}
          onChange={(e) => { setSearch(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleInputKeyDown}
          placeholder={selected.length === 0 ? 'Search or type a city…' : 'Add more…'}
          className="flex-1 min-w-[120px] bg-transparent text-white text-sm placeholder-gray-600 outline-none py-0.5"
        />

        {/* Clear all + dropdown arrow */}
        <div className="flex items-center gap-1 shrink-0 ml-auto">
          {selected.length > 0 && !disabled && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onChange([]); setSearch('') }}
              className="text-gray-600 hover:text-gray-400 text-xs px-1 transition-colors"
              title="Clear all cities"
            >
              ✕
            </button>
          )}
          <span className="text-gray-600 text-xs px-1 select-none">{open ? '▴' : '▾'}</span>
        </div>
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <div className="absolute z-50 mt-1 left-0 right-0 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
          <div className="max-h-52 overflow-y-auto">
            {/* Custom city option — if search text isn't already selected */}
            {search.trim() && !selected.includes(search.trim()) && !filtered.some(c => c.toLowerCase() === search.trim().toLowerCase()) && (
              <button
                type="button"
                onClick={() => { onChange([...selected, search.trim()]); setSearch('') }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-blue-300 hover:bg-gray-800 transition-colors border-b border-gray-800"
              >
                <span className="text-blue-500">+</span>
                Add &quot;{search.trim()}&quot;
              </button>
            )}

            {/* Country city list */}
            {filtered.length === 0 && !search.trim() && countryCities.length === 0 && (
              <div className="px-3 py-3 text-xs text-gray-600">
                No city suggestions for this country — type a city name and press Enter.
              </div>
            )}
            {filtered.length === 0 && search.trim() && (
              <div className="px-3 py-2 text-xs text-gray-600">No matching cities — press Enter to add &quot;{search.trim()}&quot;</div>
            )}

            {/* All country cities (not yet selected) when no search */}
            {!search.trim() && selected.length > 0 && (
              <div className="px-3 py-1.5 text-[10px] text-gray-600 uppercase tracking-wide border-b border-gray-800">
                {countryCities.length} cities in {COUNTRIES.find(c => c.code === country)?.name ?? country}
              </div>
            )}

            {filtered.map((city) => (
              <button
                key={city}
                type="button"
                onClick={() => toggleCity(city)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-gray-300 hover:bg-gray-800 hover:text-white transition-colors"
              >
                <span className="w-4 shrink-0 text-gray-600 text-xs">○</span>
                {city}
              </button>
            ))}

            {/* Already-selected cities shown at bottom with checkmarks */}
            {!search.trim() && selected.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-[10px] text-gray-600 uppercase tracking-wide border-t border-gray-800">
                  Selected
                </div>
                {selected.map((city) => (
                  <button
                    key={city}
                    type="button"
                    onClick={() => toggleCity(city)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-blue-300 hover:bg-gray-800 transition-colors"
                  >
                    <span className="w-4 shrink-0 text-blue-500 text-xs">✓</span>
                    {city}
                    <span className="ml-auto text-xs text-gray-600">click to remove</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function SearchConsole() {
  const { settings, update: updateSettings } = useSettingsStore()
  const { status, totalCaptured, setStatus, reset, appendLog } = useCaptureStore()

  // Whether any AI key is usable — local settings OR the backend appsettings.json.
  // Used to gate the auto-fetch of city/synonym suggestions.
  const [aiKeyAvailable, setAiKeyAvailable] = useState(
    !!(settings.openAiApiKey || settings.geminiApiKey || settings.anthropicApiKey)
  )
  useEffect(() => {
    if (settings.openAiApiKey || settings.geminiApiKey || settings.anthropicApiKey) { setAiKeyAvailable(true); return }
    resolveAiCredentials(settings).then((c) => setAiKeyAvailable(!!c.apiKey)).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.openAiApiKey, settings.geminiApiKey, settings.anthropicApiKey])

  // City as array (multi-select); derived string used for settings save + display
  const [selectedCities, setSelectedCities] = useState<string[]>([])
  const city = selectedCities.join(', ')
  const setCity = useCallback((val: string) => {
    setSelectedCities(val.split(',').map(c => c.trim()).filter(Boolean))
  }, [])

  const [keyword, setKeyword] = useState(settings.lastKeyword ?? '')
  const [sessionName, setSessionName] = useState('')
  const [country, setCountry] = useState(settings.lastCountry ?? 'IN')
  const [countrySearch, setCountrySearch] = useState('')
  const [countryOpen, setCountryOpen]     = useState(false)
  const countryRef = useRef<HTMLDivElement>(null)

  const [suggestions, setSuggestions]     = useState<string[]>([])
  const [selectedTerms, setSelectedTerms] = useState<string[]>([])

  const totalLeadsRef  = useRef(0)

  const [currentTermLabel, setCurrentTermLabel] = useState('')
  const [termProgress, setTermProgress]         = useState({ current: 0, total: 0 })
  const [error, setError] = useState('')

  // Per-run ICP / business profile — stored on the Search Session so each
  // domain (schools, pesticides, printing…) is validated against its own ICP.
  const [runProfile, setRunProfile]   = useState('')
  const [profileOpen, setProfileOpen] = useState(false)
  const profileTouchedRef = useRef(false)

  const isRunning = status === 'running' || status === 'opening_maps'

  // Pre-fill once settings finish loading
  useEffect(() => {
    if (settings.lastCity    && selectedCities.length === 0) setCity(settings.lastCity)
    if (settings.lastKeyword && !keyword) setKeyword(settings.lastKeyword)
    if (settings.lastCountry) setCountry(settings.lastCountry)
  }, [settings.lastCity, settings.lastKeyword, settings.lastCountry])

  // Pre-fill the run's ICP from the global profile — until the user edits it here
  useEffect(() => {
    if (!profileTouchedRef.current && settings.businessProfile && !runProfile) {
      setRunProfile(settings.businessProfile)
    }
  }, [settings.businessProfile])

  // Close country dropdown on outside click
  useEffect(() => {
    if (!countryOpen) return
    function handle(e: MouseEvent) {
      if (countryRef.current && !countryRef.current.contains(e.target as Node)) {
        setCountryOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [countryOpen])

  // Instant local synonym suggestions when keyword changes (offline placeholder
  // shown while the AI call below is in flight). AI-fetched related terms are
  // merged on top and kept as the user types.
  useEffect(() => {
    const local = getSuggestions(keyword)
    // Preserve any AI-fetched / already-selected terms so they aren't wiped on each keystroke.
    setSuggestions((prev) => [...new Set([...local, ...prev.filter((t) => selectedTerms.includes(t))])])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword])

  // Auto-fetch AI synonyms once the user pauses typing — this is what makes
  // suggestions genuinely dynamic for ANY keyword (not just the hardcoded map).
  // Debounced + cached per keyword, so each distinct term hits the API only once.
  const autoSynTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAutoKeyword = useRef<string>('')
  useEffect(() => {
    const kw = keyword.trim().toLowerCase()
    if (autoSynTimer.current) clearTimeout(autoSynTimer.current)
    if (kw.length < 4 || kw === lastAutoKeyword.current) return
    // No AI key (local or backend) → silently rely on the local hints.
    if (!aiKeyAvailable) return
    autoSynTimer.current = setTimeout(() => {
      lastAutoKeyword.current = kw
      runSynonymFetch(true)
    }, 1000)
    return () => { if (autoSynTimer.current) clearTimeout(autoSynTimer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, country, aiKeyAvailable])

  // Live queue progress from the service worker, which owns the multi-term run
  // (persisted queue — advancing, pacing, and retries all happen SW-side).
  // This component only renders the broadcasts.
  useEffect(() => {
    const handler = (msg: any) => {
      if (msg.type !== MSG.PROGRESS_UPDATE) return
      const q = (msg.payload as ProgressUpdatePayload)?.queue
      if (!q) return
      if (q.done) {
        setTermProgress({ current: 0, total: 0 })
        setCurrentTermLabel('')
        if (q.total > 1) toast.success(`All ${q.total} searches complete — ${q.totalLeads} total leads captured`)
        totalLeadsRef.current = 0
      } else {
        setTermProgress({ current: q.current, total: q.total })
        setCurrentTermLabel(q.total > 1 ? `${q.keyword} (${q.current}/${q.total})` : q.keyword)
        totalLeadsRef.current = q.totalLeads
      }
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  // Restore progress of a run the SW is still driving — the dashboard tab was
  // closed or refreshed mid-run, which no longer kills the run itself.
  useEffect(() => {
    chrome.runtime.sendMessage({ type: MSG.GET_STATUS })
      .then((res: any) => {
        const q = res?.searchQueue as SearchQueueProgress | null
        if (!q || q.total === 0) return
        setTermProgress({ current: q.current, total: q.total })
        setCurrentTermLabel(q.total > 1 ? `${q.keyword} (${q.current}/${q.total})` : q.keyword)
        totalLeadsRef.current = q.totalLeads
        setStatus(res?.activeSession ? 'running' : 'opening_maps')
      })
      .catch(() => {})
  }, [])

  function toggleTerm(term: string) {
    setSelectedTerms((prev) =>
      prev.includes(term) ? prev.filter((t) => t !== term) : [...prev, term]
    )
  }

  // Quick-add top cities — fetched live from the AI provider for ANY country,
  // so Uganda / Dubai / anywhere works the same as India (no hardcoded lists).
  const [fetchingTier, setFetchingTier] = useState<number | null>(null)
  async function addTopCities(n: number) {
    if (fetchingTier !== null) return
    const countryName = COUNTRIES.find((c) => c.code === country)?.name ?? country
    console.log(`[SearchConsole] Top ${n} clicked for ${countryName} (${country})`)
    setFetchingTier(n)
    try {
      const cities = await fetchTopCities(country, countryName, n, settings)
      console.log(`[SearchConsole] fetchTopCities returned ${cities.length} cities for ${countryName} (requested ${n})`, cities)
      if (!cities.length) { toast.error(`No cities returned for ${countryName}`); return }
      setSelectedCities((prev) => {
        const merged = [...new Set([...prev, ...cities])]
        console.log(`[SearchConsole] merged: ${prev.length} existing + ${cities.length} fetched = ${merged.length} total selected`)
        return merged
      })
      toast.success(`Added ${cities.length} top ${countryName} cities (AI returned ${cities.length} of ${n} requested)`)
    } catch (err: any) {
      console.error(`[SearchConsole] addTopCities(${n}) failed:`, err)
      toast.error(err?.message ?? 'Could not fetch cities')
    } finally {
      setFetchingTier(null)
    }
  }

  // Ask the AI for 10-15 related keywords / synonyms for whatever the user typed
  // — works for any keyword, not just the hardcoded local map.
  const [fetchingSynonyms, setFetchingSynonyms] = useState(false)
  // silent=true is the automatic (debounced) path — no toasts, fails quietly.
  async function runSynonymFetch(silent: boolean) {
    if (fetchingSynonyms || !keyword.trim()) return
    const countryName = COUNTRIES.find((c) => c.code === country)?.name ?? country
    setFetchingSynonyms(true)
    try {
      const terms = await fetchKeywordSynonyms(keyword.trim(), countryName, settings)
      if (!terms.length) { if (!silent) toast.error('No related keywords returned'); return }
      setSuggestions((prev) => [...new Set([...prev, ...terms])])
      if (!silent) toast.success(`Added ${terms.length} related keywords`)
    } catch (err: any) {
      if (!silent) toast.error(err?.message ?? 'Could not fetch keywords')
    } finally {
      setFetchingSynonyms(false)
    }
  }
  const suggestKeywords = () => runSynonymFetch(false)

  async function handleStart() {
    setError('')
    if (selectedCities.length === 0) { setError('Please select or type at least one city.'); return }
    if (!keyword.trim()) { setError('Please enter a keyword or business category.'); return }
    await updateSettings({ lastCity: city.trim(), lastKeyword: keyword.trim(), lastCountry: country })

    const cities        = selectedCities
    const typedKeywords = keyword.split(',').map(k => k.trim()).filter(Boolean)
    const keywords      = [...new Set([...typedKeywords, ...selectedTerms])]
    const queue: Array<{ city: string; keyword: string }> = []
    for (const c of cities) {
      for (const kw of keywords) {
        queue.push({ city: c, keyword: kw })
        // Local-language variant (e.g. Arabic "مطبعة مسقط" for Oman) — Google
        // Maps surfaces a different set of local businesses per query language.
        const localKw = getLocalKeyword(kw, country)
        if (localKw) queue.push({ city: c, keyword: localKw })
      }
    }

    // Create the Search Session — the separate workspace this run's leads,
    // validation, and research all live in.
    const runIcp = runProfile.trim() || settings.businessProfile
    const countryName = COUNTRIES.find((c) => c.code === country)?.name ?? country
    const dateLabel = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    // User-given session name wins; otherwise fall back to an auto-generated one.
    const autoName = `${keywords[0]}${keywords.length > 1 ? ` +${keywords.length - 1}` : ''} — ${countryName} — ${dateLabel}`
    const projectName = sessionName.trim() || autoName
    const projectId = await searchProjectRepository.create({
      name: projectName,
      country,
      keywords,
      cities,
      businessProfile: runIcp,
      status: 'running',
      totalTerms: queue.length,
      completedTerms: 0,
      totalLeads: 0,
      source: 'search_console',
    })

    // NOTE: the MSSQL search_run is created lazily by the service worker on the
    // first lead batch (it owns run creation + linkage — see serviceWorker.ts).
    // Creating it here as well caused a race: two runs per session, one orphaned,
    // which surfaced as a phantom "Running · 0 keyword · 0 city" duplicate session
    // card after a DB sync. So we intentionally do NOT create the run here.

    // Hand the whole run to the service worker in one message. The SW persists
    // the queue and drives every term itself (sessions, pacing, tab handling),
    // so closing or refreshing this dashboard tab no longer kills the run.
    reset()
    setStatus('opening_maps')
    totalLeadsRef.current = 0
    setTermProgress({ current: 1, total: queue.length })
    setCurrentTermLabel(queue.length > 1 ? `${queue[0].keyword} (1/${queue.length})` : queue[0].keyword)
    appendLog(`Search run started — ${queue.length} search${queue.length > 1 ? 'es' : ''} queued`)
    toast.info(`Session "${projectName}" started — opening Google Maps`)

    const payload: SearchQueueStartPayload = {
      terms: queue,
      country,
      settings: {
        autoScrollDelay:         settings.autoScrollDelay,
        maxScrollAttempts:       settings.maxScrollAttempts,
        noNewLeadStopThreshold:  settings.noNewLeadStopThreshold,
      },
      projectId,
    }

    chrome.runtime.sendMessage({ type: MSG.SEARCH_QUEUE_START, payload })
      .then((res: any) => {
        // The service worker resolves (doesn't reject) even on failure — e.g.
        // opening the Maps tab failed after retries. Surface it instead of
        // leaving the console stuck on "opening_maps".
        if (res && res.ok === false) {
          setError(res.error ?? 'Failed to start the search run')
          setStatus('error')
          toast.error(`Failed to start: ${res.error ?? 'unknown error'}`)
          // The run never started — don't leave its session card stuck on "Running"
          searchProjectRepository.setStatus(projectId, 'stopped').catch(() => {})
        }
      })
      .catch(() => {
        setError('Failed to communicate with background worker. Try reloading the extension.')
        setStatus('error')
        toast.error('Could not start capture — try reloading the extension.')
        searchProjectRepository.setStatus(projectId, 'stopped').catch(() => {})
      })
  }

  async function handleStop() {
    // CAPTURE_STOP also clears the SW's persisted queue — Stop means the whole
    // run, including terms not yet started.
    await chrome.runtime.sendMessage({ type: MSG.CAPTURE_STOP })
    setStatus('stopped')
    setTermProgress({ current: 0, total: 0 })
    setCurrentTermLabel('')
    appendLog('Capture stopped by user')
    toast.warning('Capture stopped')
  }

  const allKeywords      = [...new Set([...keyword.split(',').map(k => k.trim()).filter(Boolean), ...selectedTerms])]
  const totalSearches    = selectedCities.length * allKeywords.length
  const hasMultipleTerms = totalSearches > 1

  return (
    <div className="relative overflow-hidden bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4 shadow-lg shadow-black/20 animate-fade-in-up">
      {/* Soft gradient accent along the top edge */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-500 via-indigo-500 to-violet-500 opacity-80" />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex items-center justify-center w-9 h-9 rounded-xl text-base
            bg-gradient-to-br from-blue-500/20 to-violet-500/20 border border-blue-500/30 text-blue-200">⌕</span>
          <div>
            <h2 className="font-semibold text-white text-sm leading-none">Search Console</h2>
            <p className="text-[11px] text-gray-500 mt-1">Capture → validate → research, in one run</p>
          </div>
        </div>
        {isRunning && (
          <span className="flex items-center gap-1.5 text-xs text-green-400 font-medium">
            <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
            {currentTermLabel ? `Searching: ${currentTermLabel}` : 'Capture Active'}
          </span>
        )}
      </div>

      {/* Input grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">

        {/* Session name — this run's workspace. Leads, validation, research and
            company intelligence all stay grouped under this one session. */}
        <div className="sm:col-span-2">
          <label className="block text-xs text-gray-400 mb-1 font-medium">
            Session name
            <span className="ml-1.5 text-gray-600 font-normal">— groups this run's leads, validation &amp; research in one workspace</span>
          </label>
          <input
            type="text"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            disabled={isRunning}
            placeholder="e.g. Printing — Gujarat   ·   Pesticides — Punjab   (blank = auto-named)"
            className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg placeholder-gray-600
              focus:outline-none focus:border-blue-500 disabled:opacity-50 transition-colors"
          />
        </div>

        {/* Market / Country selector */}
        <div className="sm:col-span-2" ref={countryRef}>
          <label className="block text-xs text-gray-400 mb-1 font-medium">Market</label>
          <div className="relative">
            <button
              type="button"
              disabled={isRunning}
              onClick={() => { setCountryOpen((v) => !v); setCountrySearch('') }}
              className="flex items-center gap-2 bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg
                hover:border-gray-600 disabled:opacity-50 transition-colors min-w-[180px]"
            >
              <span className="text-base">{flag(country)}</span>
              <span className="flex-1 text-left">{COUNTRIES.find(c => c.code === country)?.name ?? country}</span>
              <span className="text-gray-500 text-xs">{country}</span>
              <span className="text-gray-500">▾</span>
            </button>

            {countryOpen && (
              <div className="absolute z-50 mt-1 w-72 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
                <div className="p-2 border-b border-gray-800">
                  <input
                    autoFocus
                    type="text"
                    value={countrySearch}
                    onChange={(e) => setCountrySearch(e.target.value)}
                    placeholder="Search country…"
                    className="w-full bg-gray-800 border border-gray-700 text-white text-xs px-2.5 py-1.5 rounded-lg
                      placeholder-gray-600 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div className="max-h-56 overflow-y-auto">
                  {COUNTRIES
                    .filter(c =>
                      !countrySearch ||
                      c.name.toLowerCase().includes(countrySearch.toLowerCase()) ||
                      c.code.toLowerCase().includes(countrySearch.toLowerCase())
                    )
                    .map(c => (
                      <button
                        key={c.code}
                        type="button"
                        onClick={() => { setCountry(c.code); setCountryOpen(false); setCountrySearch('') }}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors ${
                          c.code === country
                            ? 'bg-blue-600 text-white'
                            : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                        }`}
                      >
                        <span className="text-base shrink-0">{flag(c.code)}</span>
                        <span className="flex-1">{c.name}</span>
                        <span className="text-xs text-gray-500">{c.code}</span>
                      </button>
                    ))
                  }
                </div>
              </div>
            )}
          </div>
        </div>

        {/* City multi-select */}
        <div className="sm:col-span-2">
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-gray-400 font-medium">
              City
              <span className="ml-1.5 text-gray-600 font-normal">
                — {COUNTRIES.find(c => c.code === country)?.name ?? country}
              </span>
            </label>
            {selectedCities.length > 1 && (
              <span className="text-xs text-blue-400">{selectedCities.length} cities selected</span>
            )}
          </div>
          <CityMultiSelect
            selected={selectedCities}
            onChange={setSelectedCities}
            country={country}
            disabled={isRunning}
          />
          <p className="mt-1 text-xs text-gray-700">
            Select from list or type any city name and press Enter. Multiple cities run sequentially.
          </p>

          {/* City quick-add — fetched live from AI for whatever country is selected */}
          {!isRunning && (
            <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] text-gray-500">AI quick-add top cities:</span>
              {[50, 100, 200, 500].map((n) => (
                <button
                  key={n}
                  type="button"
                  disabled={fetchingTier !== null}
                  onClick={() => addTopCities(n)}
                  className="text-xs px-2.5 py-1 rounded-full text-gray-300 border border-gray-700 bg-gray-800/60
                    hover:border-indigo-500/50 hover:text-indigo-200 transition-all active:scale-95
                    disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                >
                  {fetchingTier === n && (
                    <span className="inline-block w-3 h-3 border-2 border-indigo-400/40 border-t-indigo-400 rounded-full animate-spin" />
                  )}
                  Top {n}
                </button>
              ))}
              {fetchingTier !== null && (
                <span className="text-[11px] text-gray-500 animate-pulse">
                  Asking AI for top {fetchingTier} cities in {COUNTRIES.find((c) => c.code === country)?.name ?? country}…
                </span>
              )}
              {selectedCities.length > 0 && fetchingTier === null && (
                <button
                  type="button"
                  onClick={() => setSelectedCities([])}
                  className="text-xs px-2.5 py-1 rounded-full text-gray-500 hover:text-gray-300 transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </div>

        <div className="sm:col-span-2">
          <label className="block text-xs text-gray-400 mb-1 font-medium">Keyword / Business Category</label>
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !isRunning && handleStart()}
            placeholder="e.g. Printing, CA Firms, Dentists (comma-separated = multiple searches)"
            disabled={isRunning}
            className="w-full bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg placeholder-gray-600
              focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50 transition-colors"
          />
        </div>
      </div>

      {/* Per-run ICP / Business Profile — stored on this session only */}
      {!isRunning && (
        <div className="bg-gray-950/60 border border-gray-800 rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setProfileOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-gray-900/60 transition-colors"
          >
            <span className="text-xs font-semibold text-purple-300 shrink-0">ICP for this session</span>
            {!profileOpen && (
              <span className="text-[10px] text-gray-600 flex-1 truncate">
                {runProfile.trim() ? runProfile.trim().replace(/\s+/g, ' ').slice(0, 90) : 'no profile set — leads will skip validation'}
              </span>
            )}
            {profileOpen && <span className="flex-1" />}
            <span className="text-gray-600 text-xs shrink-0">{profileOpen ? '▴ collapse' : '▾ review / edit'}</span>
          </button>
          {profileOpen && (
            <div className="px-3 pb-3 space-y-1.5">
              <textarea
                value={runProfile}
                onChange={(e) => { setRunProfile(e.target.value); profileTouchedRef.current = true }}
                rows={8}
                placeholder="Describe YOUR business and its ideal customers for this run — every captured lead is validated and researched against this."
                className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-xs px-2.5 py-2 rounded-lg leading-relaxed
                  placeholder-gray-600 focus:outline-none focus:border-purple-600 focus:ring-1 focus:ring-purple-600"
              />
              <div className="text-[10px] text-gray-600">
                Saved on this session only. Schools, pesticides, printing — each run keeps its own ICP; other sessions are untouched.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Related search terms */}
      {!isRunning && (suggestions.length > 0 || keyword.trim()) && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-500 font-medium">Also search for</span>
            {keyword.trim() && (
              <button
                onClick={suggestKeywords}
                disabled={fetchingSynonyms}
                className="text-xs px-2.5 py-1 rounded-full font-medium text-indigo-100 border border-indigo-500/40
                  bg-gradient-to-r from-blue-600/25 to-violet-600/25 hover:from-blue-600/40 hover:to-violet-600/40
                  hover:border-indigo-400/60 transition-all active:scale-95 disabled:opacity-50
                  disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {fetchingSynonyms && (
                  <span className="inline-block w-3 h-3 border-2 border-indigo-300/40 border-t-indigo-200 rounded-full animate-spin" />
                )}
                {fetchingSynonyms ? 'Asking AI…' : 'AI suggest related'}
              </button>
            )}
            {selectedTerms.length > 0 && (
              <span className="text-xs text-blue-400">
                +{selectedTerms.length} term{selectedTerms.length > 1 ? 's' : ''} selected
              </span>
            )}
            {selectedTerms.length > 0 && (
              <button
                onClick={() => setSelectedTerms([])}
                className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
              >
                Clear all
              </button>
            )}
          </div>
          {suggestions.length === 0 && (
            <p className="text-xs text-gray-600">
              {fetchingSynonyms
                ? <>Fetching related categories for “{keyword.trim()}”…</>
                : <>Related categories for “{keyword.trim()}” load automatically — or click <span className="text-indigo-300">AI suggest related</span>.</>}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((term) => {
              const active = selectedTerms.includes(term)
              return (
                <button
                  key={term}
                  onClick={() => toggleTerm(term)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    active
                      ? 'bg-blue-700 border-blue-600 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-blue-700 hover:text-blue-300'
                  }`}
                >
                  {active ? '✓ ' : '+ '}{term}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Auto-pipeline info */}
      {!isRunning && (selectedCities.length > 0 || keyword.trim()) && (
        <div className="bg-green-950/30 border border-green-900/40 rounded-lg px-3 py-2.5 space-y-1">
          <div className="text-xs text-green-300 font-semibold">⚡ Fully Automated Pipeline</div>
          <div className="text-xs text-green-400/80 space-y-0.5">
            <div>1 · Capture leads from Google Maps</div>
            <div>2 · Gemini grounding enrichment (teamSize, turnover, CIN, directors)</div>
            <div>3 · ICP batch validation — score every lead against your business profile</div>
            <div>4 · Queue all qualified leads for deep web research</div>
            <div>5 · Research runs automatically — no clicks needed</div>
          </div>
        </div>
      )}

      {/* Search queue preview */}
      {!isRunning && hasMultipleTerms && (
        <div className="bg-blue-950/30 border border-blue-900/40 rounded-lg px-3 py-2 space-y-1">
          <div className="text-xs text-blue-300 font-medium">
            Will search {totalSearches} combinations sequentially
            {selectedCities.length > 1 && allKeywords.length > 1
              ? ` (${selectedCities.length} cities × ${allKeywords.length} keywords)`
              : selectedCities.length > 1
              ? ` (${selectedCities.length} cities)`
              : ` (${allKeywords.length} keywords)`}:
          </div>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {selectedCities.flatMap((c, ci) =>
              allKeywords.map((kw, ki) => {
                const idx = ci * allKeywords.length + ki
                return (
                  <span key={`${c}-${kw}`} className="text-xs px-2 py-0.5 bg-blue-900/40 text-blue-200 rounded border border-blue-800/40">
                    {idx + 1}. {kw}{selectedCities.length > 1 ? ` — ${c}` : ''}
                  </span>
                )
              })
            )}
          </div>
          <div className="text-xs text-blue-400/70">Duplicates across searches are automatically skipped</div>
        </div>
      )}

      {/* Search presets */}
      <SearchPresets
        city={city}
        keyword={keyword}
        maxResults={100}
        onLoad={(c, k) => { setCity(c); setKeyword(k) }}
      />

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 bg-red-950 border border-red-800 text-red-300 text-xs px-3 py-2 rounded-lg">
          <span className="shrink-0 mt-0.5">✕</span>
          <span>{error}</span>
        </div>
      )}

      {/* Progress — multi-term */}
      {isRunning && termProgress.total > 1 && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs text-gray-400">
            <span>Term {termProgress.current} of {termProgress.total}</span>
            <span className="font-medium text-white">{totalCaptured} leads this search</span>
          </div>
          <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-500"
              style={{ width: `${Math.round(((termProgress.current - 1) / termProgress.total) * 100)}%` }}
            />
          </div>
          <div className="text-xs text-gray-600">
            {totalLeadsRef.current > 0 && `${totalLeadsRef.current} leads collected so far`}
          </div>
        </div>
      )}

      {/* Progress — single term */}
      {isRunning && termProgress.total <= 1 && totalCaptured > 0 && (
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
          <span>{totalCaptured} leads captured — scrolling for more…</span>
        </div>
      )}

      {/* Completed */}
      {(status === 'completed' || status === 'stopped') && termProgress.total === 0 && (
        <div className="flex items-center justify-between text-xs text-gray-400">
          <span>{status === 'completed' ? 'Search complete' : 'Search stopped'}</span>
          <span className="font-medium text-white">{totalCaptured} leads captured</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 flex-wrap items-center">
        {!isRunning ? (
          <button
            onClick={handleStart}
            className="group px-5 py-2.5 text-white text-sm font-semibold rounded-xl transition-all duration-200
              bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600
              hover:from-blue-500 hover:via-indigo-500 hover:to-violet-500
              hover:shadow-lg hover:shadow-indigo-900/50 hover:-translate-y-0.5 active:translate-y-0
              focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
          >
            <span className="inline-block transition-transform group-hover:translate-x-0.5">▶</span>{' '}
            {hasMultipleTerms ? `Start Full Pipeline (${totalSearches} searches)` : 'Start Full Pipeline'}
          </button>
        ) : (
          <button
            onClick={handleStop}
            className="px-5 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            Stop Capture
          </button>
        )}

        {!isRunning && (selectedCities.length > 0 || keyword) && (
          <button
            onClick={() => { setSelectedCities([]); setKeyword(''); setSelectedTerms([]); setError('') }}
            className="px-3 py-2 text-gray-500 hover:text-gray-300 text-sm transition-colors"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  )
}
