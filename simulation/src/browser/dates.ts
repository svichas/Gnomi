// A native date or time field takes no free typing: on a phone the OS picker sets it, and on a computer its segments follow
// the region of the machine running Gnomi, not the persona's. When a persona types into one, this reads what they typed as
// the value their picker would set, in the persona's own order and words.
// shortcut: an ambiguous day and month (both 12 or under) follow the persona's locale, not the field's own display order,
// which Chromium does not expose; upgrade if personas type in an order their locale does not use.

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
/** Lower case without accents, so "Οκτωβρίου" and "οκτωβριου", or "März" and "marz", read the same. */
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function date([a, b, c]: number[], yearFirst: boolean, dayFirst: boolean): string | null {
  let [year, month, day] = yearFirst ? [a, b, c] : dayFirst ? [c, b, a] : [c, a, b];
  if (month > 12 && day <= 12) [month, day] = [day, month];
  if (year < 100) year += 2000;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null; // 31/02, month 0
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function time([hour, minute = 0]: number[], text: string): string | null {
  if (/\bp\.?\s?m\b|μ\.?\s?μ/i.test(text) && hour < 12) hour += 12;
  else if (/\ba\.?\s?m\b|π\.?\s?μ/i.test(text) && hour === 12) hour = 0;
  return hour > 23 || minute > 59 ? null : `${pad(hour)}:${pad(minute)}`;
}

/** The month (1–12) a word in `text` names in English or in `locale`, in full or cut short; null for none, or for two. */
function namedMonth(text: string, locale: string): number | null {
  const words = [...fold(text).matchAll(/\p{L}{3,}/gu)].map(([word]) => word);
  if (words.length === 0) return null;
  const names = Array.from({ length: 12 }, (_, m) => {
    const when = new Date(Date.UTC(2026, m, 15));
    return ['en', locale].flatMap((tag) => (['long', 'short'] as const).flatMap((month) => [
      new Intl.DateTimeFormat(tag, { month, timeZone: 'UTC' }).format(when),
      // As in a date, which in Greek or Polish is another form: "25 Οκτωβρίου", not "Οκτώβριος".
      new Intl.DateTimeFormat(tag, { month, day: 'numeric', timeZone: 'UTC' }).formatToParts(when).find((part) => part.type === 'month')?.value ?? '',
    ])).map(fold);
  });
  const months = new Set(words.flatMap((word) => names.flatMap((forms, m) => (forms.some((name) => name.startsWith(word)) ? [m + 1] : []))));
  return months.size === 1 ? [...months][0] : null; // "mar. 25 oct." also names a weekday (mardi): unreadable rather than March
}

/** "07072026" or "20261025" as three groups: year first when it starts like a year and reads as a date that way. */
function eightDigits(run: string, dayFirst: boolean): string[] {
  const ymd = [run.slice(0, 4), run.slice(4, 6), run.slice(6)];
  return /^(?:19|20)/.test(run) && date(ymd.map(Number), true, dayFirst) ? ymd : [run.slice(0, 2), run.slice(2, 4), run.slice(4)];
}

/** The ISO value a picker would set for `text` typed into an <input type>, or null when it reads as no such value. */
export function pickedValue(type: string, text: string, dayFirst: boolean, locale = 'en'): string | null {
  let digits: string[] = text.match(/\d+/g) ?? [];
  if (/^\d{8}$/.test(digits[0] ?? '')) digits = [...eightDigits(digits[0], dayFirst), ...digits.slice(1)];
  const n = digits.map(Number);
  const named = namedMonth(text, locale);
  const year = digits.findIndex((d) => d.length === 4);
  // A named month leaves a day and a year in digits, in either order; otherwise the day takes three groups.
  const used = named ? 2 : 3;
  const day = () => (!named ? date(n, digits[0].length === 4, dayFirst) : year === 0 || year === 1 ? date([n[year], named, n[1 - year]], true, dayFirst) : null);
  switch (type) {
    case 'date':
      return n.length >= used ? day() : null;
    case 'time':
      return n.length >= 1 ? time(n, text) : null;
    case 'datetime-local': {
      if (n.length < used + 1) return null;
      const [when, clock] = [day(), time(n.slice(used), text)];
      return when && clock ? `${when}T${clock}` : null;
    }
    case 'month': {
      const month = named ?? n[year === 0 ? 1 : 0];
      return year !== -1 && (named !== null || n.length >= 2) && month >= 1 && month <= 12 ? `${digits[year]}-${pad(month)}` : null;
    }
    case 'week': {
      const week = n[year === 0 ? 1 : 0];
      return year !== -1 && n.length >= 2 && week >= 1 && week <= 53 ? `${digits[year]}-W${pad(week)}` : null;
    }
    default:
      return null;
  }
}
