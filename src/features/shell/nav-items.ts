/**
 * Selectable top-navbar sections. "Systems" is NOT here — it's a static label
 * box rendered separately in the navbar. Each id doubles as:
 *   - the i18n key → messages `shell.nav.<id>` (used as the box's aria-label)
 *   - the icon file → /public/icons/nav/<id>.svg (rendered via <Icon>)
 *
 * `href` links the box to its route; the box is "selected" when the current
 * pathname matches. Sections without a built route yet have no href (the box is
 * shown but not navigable). Add routes here as the screens land.
 */
export type NavId =
  | "rocket"
  | "translate"
  | "currencies"
  | "countries"
  | "database"
  | "hierarchy";

export const NAV_ITEMS: readonly { id: NavId; href?: string }[] = [
  { id: "rocket", href: "/systems" }, // System Projects
  { id: "translate", href: "/languages" }, // System Languages
  { id: "currencies", href: "/currencies" }, // System Currencies
  { id: "countries", href: "/regions" }, // System Geographic Regions
  { id: "database" },
  { id: "hierarchy" },
];
