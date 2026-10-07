export type Locale = 'en' | 'ru';
export const locales: readonly Locale[] = ['en', 'ru'];

/** First supported language from the browser's preference list, else English. */
export function pickLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    if (base === 'ru' || base === 'en') return base;
  }
  return 'en';
}

const PLURAL = /\{(\w+), plural, ((?:\w+ \{[^}]*\}\s*)+)\}/g;
const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Tiny ICU-style formatter: `{name}` placeholders and
 * `{count, plural, one {# item} other {# items}}` using Intl.PluralRules.
 */
export function formatMessage(
  template: string,
  locale: Locale,
  values: Record<string, string | number> = {},
): string {
  const withPlurals = template.replace(PLURAL, (_, name: string, body: string) => {
    const count = Number(values[name] ?? 0);
    const forms = Object.fromEntries(
      [...body.matchAll(/(\w+) \{([^}]*)\}/g)].map((m) => [m[1], m[2]] as const),
    );
    const category = new Intl.PluralRules(locale).select(count);
    const form = forms[category] ?? forms.other ?? '';
    return form.replace(/#/g, new Intl.NumberFormat(locale).format(count));
  });
  return withPlurals.replace(PLACEHOLDER, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

export function formatBytes(bytes: number, locale: Locale): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

export function formatDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}
