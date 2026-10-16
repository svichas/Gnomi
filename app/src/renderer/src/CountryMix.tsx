import { COUNTRY_PROFILES, countryName } from '@gnomi/engine/audience/locations.ts';
import { countryShares, removeCountry, setCountryShare } from './audience.ts';
import { Button, Field, inputClass, NumberInput } from './ui.tsx';

export function CountryMix({ countries, onChange }: { countries?: Record<string, number>; onChange(countries: Record<string, number> | undefined): void }) {
  const shares = countryShares(countries ?? {});
  const entries = Object.entries(shares);
  const available = COUNTRY_PROFILES.filter((profile) => !Object.hasOwn(shares, profile.code));
  return (
    <fieldset className="space-y-3 rounded-lg border border-stone-200 p-4">
      <legend className="px-1 text-sm font-semibold text-stone-900">Countries</legend>
      <p className="text-sm text-stone-600">
        Choose where the audience lives. Each country uses the reference city below to set browser language and timezone. Shares add up to 100%; small populations will vary.
      </p>
      {!entries.length && <p className="text-sm text-stone-600">No country mix selected. Existing first-language sampling is used.</p>}
      {entries.map(([code, share]) => {
        const profile = COUNTRY_PROFILES.find((item) => item.code === code);
        return (
          <div key={code} className="flex flex-wrap items-center gap-3">
            <div className="min-w-40 flex-1">
              <p className="text-sm font-medium text-stone-900">{countryName(code)}</p>
              {profile && <p className="text-xs text-stone-500">{profile.city} · {profile.timezone} · {profile.languages.join(', ')}</p>}
            </div>
            <div className="w-24">
              <NumberInput label={`Share in ${countryName(code)} (%)`} value={share} min={entries.length === 1 ? 100 : 0} max={100} onChange={(value) => onChange(setCountryShare(shares, code, value))} />
            </div>
            <span className="text-sm text-stone-500">%</span>
            <Button aria-label={`Remove country ${countryName(code)}`} onClick={() => onChange(removeCountry(shares, code))}>Remove</Button>
          </div>
        );
      })}
      {available.length > 0 && (
        <Field label="Add country">
          <select className={inputClass} value="" onChange={(event) => event.target.value && onChange(setCountryShare(shares, event.target.value, Math.round(100 / (entries.length + 1))))}>
            <option value="">Choose a country</option>
            {available.map((profile) => <option key={profile.code} value={profile.code}>{profile.name}</option>)}
          </select>
        </Field>
      )}
    </fieldset>
  );
}
