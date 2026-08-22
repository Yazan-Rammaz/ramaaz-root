import { listRegions } from "@/features/region/api";
import { RegionList } from "@/features/region/components/RegionList";

/**
 * System Geographic Regions — the countries/regions list (empty for now).
 * Renders inside the (dashboard) shell; the layout provides the <main> scroll
 * region and the requireSession() gate, so this page stays thin.
 */
export default async function RegionsPage() {
  const regions = await listRegions();
  return <RegionList items={regions} />;
}
