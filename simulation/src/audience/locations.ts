import type { Audience, Persona } from '../types.ts';

export interface CountryProfile {
  code: string;
  name: string;
  city: string;
  timezone: string;
  languages: string[];
}

// One reference location per supported country, not a demographic model of its population.
// Cities stay fixed in this slice. Country weights belong to the project, never to this catalogue.
export const COUNTRY_PROFILES: readonly CountryProfile[] = [
  { code: 'AU', name: 'Australia', city: 'Sydney', timezone: 'Australia/Sydney', languages: ['en-AU'] },
  { code: 'BR', name: 'Brazil', city: 'São Paulo', timezone: 'America/Sao_Paulo', languages: ['pt-BR', 'en'] },
  { code: 'CA', name: 'Canada', city: 'Toronto', timezone: 'America/Toronto', languages: ['en-CA', 'fr-CA'] },
  { code: 'DE', name: 'Germany', city: 'Berlin', timezone: 'Europe/Berlin', languages: ['de-DE', 'en'] },
  { code: 'ES', name: 'Spain', city: 'Madrid', timezone: 'Europe/Madrid', languages: ['es-ES', 'en'] },
  { code: 'FR', name: 'France', city: 'Paris', timezone: 'Europe/Paris', languages: ['fr-FR', 'en'] },
  { code: 'GB', name: 'United Kingdom', city: 'London', timezone: 'Europe/London', languages: ['en-GB'] },
  { code: 'GR', name: 'Greece', city: 'Athens', timezone: 'Europe/Athens', languages: ['el-GR', 'en'] },
  { code: 'IN', name: 'India', city: 'New Delhi', timezone: 'Asia/Kolkata', languages: ['hi-IN', 'en-IN'] },
  { code: 'JP', name: 'Japan', city: 'Tokyo', timezone: 'Asia/Tokyo', languages: ['ja-JP', 'en'] },
  { code: 'NL', name: 'Netherlands', city: 'Amsterdam', timezone: 'Europe/Amsterdam', languages: ['nl-NL', 'en'] },
  { code: 'PT', name: 'Portugal', city: 'Lisbon', timezone: 'Europe/Lisbon', languages: ['pt-PT', 'en'] },
  { code: 'SE', name: 'Sweden', city: 'Stockholm', timezone: 'Europe/Stockholm', languages: ['sv-SE', 'en'] },
  { code: 'US', name: 'United States', city: 'New York', timezone: 'America/New_York', languages: ['en-US'] },
];

export const countryName = (code: string): string => COUNTRY_PROFILES.find((p) => p.code === code)?.name ?? code;

/** Validate even zero-weight keys, so a misspelled country cannot silently enter a saved project. */
export function validateCountries(countries?: Record<string, number>): void {
  if (countries === undefined) return;
  if (!countries || typeof countries !== 'object' || Array.isArray(countries)) throw new Error('Country shares must be a country-to-weight map.');
  for (const [code, weight] of Object.entries(countries)) {
    if (!COUNTRY_PROFILES.some((p) => p.code === code)) throw new Error(`Unsupported country code: ${code}. Choose a country from the list.`);
    if (!Number.isFinite(weight) || weight < 0) throw new Error(`The country share for ${code} must be a finite, non-negative number.`);
  }
  if (!Object.values(countries).some((weight) => weight > 0)) throw new Error('At least one country must have a positive share.');
}

/** Every country mix sampling can read: the audience's and each segment's, which replaces it. */
export function validateAudienceCountries({ countries, segments }: Pick<Audience, 'countries' | 'segments'>): void {
  validateCountries(countries);
  for (const segment of segments) {
    try { validateCountries(segment.countries); } catch (error) {
      throw new Error(`${segment.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export interface LocaleEnvironment {
  locale: string;
  timezone: string;
  languages: string[];
}

const languageTag = (tag: string): string | null => {
  try { return Intl.getCanonicalLocales(tag)[0] ?? null; } catch { return null; }
};

/** Old personas keep their first language; UTC makes their previously unspecified timezone reproducible. */
export function personaEnvironment(persona: Pick<Persona, 'language' | 'languages' | 'timezone'>): LocaleEnvironment {
  const preferred = persona.languages?.map(languageTag).filter((tag): tag is string => tag !== null) ?? [];
  const languages = [...new Set(preferred.length ? preferred : [languageTag(persona.language) ?? 'en-US'])];
  let timezone = persona.timezone ?? 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { timezone = 'UTC'; }
  return { locale: languages[0], timezone, languages };
}
