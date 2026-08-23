/**
 * i18n — the ONE source of truth for languages & direction.
 *
 * Add a language in exactly one place: add it to `locales` and add its
 * `messages/<code>.json` file. Direction is derived automatically from the code
 * (see `localeDirection`) — pages and components never decide LTR/RTL themselves.
 *
 * This module is edge-safe (no `server-only`, no `next/headers`) so the proxy,
 * Server Components and Client Components can all import it.
 */

export const locales = ["en", "ar", "tr"] as const;
export type Locale = (typeof locales)[number];

/** Falls back here when no cookie is set and the browser language is unsupported. */
export const defaultLocale: Locale = "en";

/** Cookie that carries the chosen language across requests (set by the switcher). */
export const LOCALE_COOKIE = "root_lang";

/** One year — the user's language is a sticky preference. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Text direction per language. This is the ONLY place direction is decided; it
 * is applied once on <html dir>. Components must stay direction-agnostic by
 * using logical Tailwind utilities (ps/pe, ms/me, start/end, text-start/end) —
 * never left/right — so they flip automatically. See AGENTS.md §10.
 */
const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(["ar"]);

export function localeDirection(locale: Locale): "ltr" | "rtl" {
  return RTL_LOCALES.has(locale) ? "rtl" : "ltr";
}

/** Native display names for the language switcher. */
export const localeNames: Record<Locale, string> = {
  en: "English",
  ar: "العربية",
  tr: "Türkçe",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

/**
 * Pick the best supported locale from an `Accept-Language` header.
 * Used by the proxy for first-visit auto-detection. Matches on the primary
 * subtag (e.g. `ar-SA` → `ar`) and honours quality weights.
 */
export function matchLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return defaultLocale;

  const ranked = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="));
      const weight = q ? Number.parseFloat(q.slice(2)) : 1;
      return { tag: tag.toLowerCase(), weight: Number.isNaN(weight) ? 1 : weight };
    })
    .sort((a, b) => b.weight - a.weight);

  for (const { tag } of ranked) {
    const primary = tag.split("-")[0];
    const hit = locales.find((l) => l === primary);
    if (hit) return hit;
  }
  return defaultLocale;
}
