/**
 * A typed place name with the first letter of each word upper-cased ("syria"
 * → "Syria", "bosnia and herzegovina" → "Bosnia And Herzegovina"). The rest is
 * left as typed. Only the fallback when the AI has no proper English name.
 */
export function titleCase(name: string) {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(^|[\s-])(\p{Ll})/gu, (_, sep: string, ch: string) => sep + ch.toLocaleUpperCase("en"));
}
