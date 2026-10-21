// A phone's native date and time fields take no typing: the OS picker sets them. When a persona types into one,
// this reads what they typed as the value that picker would set.
// shortcut: an ambiguous day and month (both 12 or under) follow the persona's locale, not the field's own display order,
// which Chromium does not expose; upgrade if personas type in an order their locale does not use.

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function date([a, b, c]: number[], digits: string[], dayFirst: boolean): string | null {
  let [year, month, day] = digits[0].length === 4 ? [a, b, c] : dayFirst ? [c, b, a] : [c, a, b];
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

/** The ISO value a picker would set for `text` typed into an <input type>, or null when it reads as no such value. */
export function pickedValue(type: string, text: string, dayFirst: boolean): string | null {
  const digits = text.match(/\d+/g) ?? [];
  const n = digits.map(Number);
  switch (type) {
    case 'date':
      return n.length >= 3 ? date(n, digits, dayFirst) : null;
    case 'time':
      return n.length >= 1 ? time(n, text) : null;
    case 'datetime-local': {
      if (n.length < 4) return null;
      const [day, clock] = [date(n, digits, dayFirst), time(n.slice(3), text)];
      return day && clock ? `${day}T${clock}` : null;
    }
    case 'month': {
      const year = digits.findIndex((d) => d.length === 4);
      const month = n[year === 0 ? 1 : 0];
      return n.length >= 2 && year !== -1 && month >= 1 && month <= 12 ? `${digits[year]}-${pad(month)}` : null;
    }
    default:
      return null; // week: rare enough to leave as typed
  }
}
