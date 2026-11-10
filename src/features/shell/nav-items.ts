/**
 * Selectable top-navbar sections. "Systems" is NOT here — it's a static label
 * box rendered separately in the navbar. Each id doubles as:
 *   - the i18n key → messages `shell.nav.<id>` (used as the box's aria-label)
 *   - the icon file → /public/icons/nav/<id>.svg (rendered via <Icon>)
 *
 * `href` links the box to its route; the box is "selected" when the current
 * pathname matches. Sections without a built route yet have no href (the box is
 * shown but not navigable). Add routes here as the screens land.
 *
 * `project` marks a section that works on the SELECTED system's data. Those
 * stay folded away until a system is picked on /systems, then unfold (see
 * Navbar). Only the systems list itself is reachable with nothing selected.
 */
export type NavId =
  | "rocket"
  | "translate"
  | "currencies"
  | "countries"
  | "database"
  | "hierarchy"
  | "business";

export const NAV_ITEMS: readonly { id: NavId; href?: string; project?: true }[] = [
  { id: "rocket", href: "/systems" }, // System Projects
  { id: "translate", href: "/languages", project: true }, // System Languages
  { id: "currencies", href: "/currencies", project: true }, // System Currencies
  { id: "countries", href: "/regions", project: true }, // System Geographic Regions
  { id: "database", href: "/dashboard-types", project: true }, // System Dashboards Type
  { id: "hierarchy", href: "/roles", project: true }, // System RBAC | Roles
  { id: "business", href: "/business-types", project: true }, // System Business Type
];
