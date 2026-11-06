/**
 * Countries Nooi sells and ships to — ISO 3166-1 alpha-2.
 * Same list as the frontend's lib/listings/countries.ts.
 */

export const COUNTRIES: Record<string, string> = {
  SA: 'Saudi Arabia',
  AE: 'United Arab Emirates',
  KW: 'Kuwait',
  QA: 'Qatar',
  BH: 'Bahrain',
  OM: 'Oman',
  JO: 'Jordan',
  EG: 'Egypt',
  TR: 'Turkey',
  IT: 'Italy',
  CN: 'China',
  IN: 'India',
  MY: 'Malaysia',
  ID: 'Indonesia',
  VN: 'Vietnam',
  DE: 'Germany',
  ES: 'Spain',
  PT: 'Portugal',
  GB: 'United Kingdom',
  US: 'United States',
  DK: 'Denmark',
  BD: 'Bangladesh',
};

const BY_NAME = new Map(Object.entries(COUNTRIES).map(([code, name]) => [name.toLowerCase(), code]));
BY_NAME.set('ksa', 'SA');
BY_NAME.set('saudi', 'SA');
BY_NAME.set('uae', 'AE');
BY_NAME.set('uk', 'GB');
BY_NAME.set('usa', 'US');

/** "sa", "SA", "Saudi Arabia", "KSA" → "SA". Unknown → null. */
export function countryCode(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^[a-z]{2}$/i.test(s)) return s.toUpperCase();
  return BY_NAME.get(s.toLowerCase()) ?? null;
}

export const countryName = (code: string) => COUNTRIES[code] ?? code;
