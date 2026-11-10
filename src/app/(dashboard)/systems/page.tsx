import { getSavedBaseUrl, listSystems } from "@/features/system/api";
import { SystemList } from "@/features/system/components/SystemList";
import { getSelectedSystemId } from "@/lib/api/backend";

/**
 * Systems — the "System Projects" list. Renders inside the (dashboard) shell
 * (sidebar + navbar); the layout already provides the <main> scroll region and
 * the requireSession() gate, so this page stays thin. Clicking a system
 * selects it — project pages then talk to that system's backend.
 *
 * With the connect step open (`?add=connect&id=…`) it also reads the base URL
 * the last connect saved, so the step opens pre-filled.
 */
export default async function SystemsPage({
  searchParams,
}: {
  searchParams: Promise<{ add?: string; id?: string }>;
}) {
  const { add, id } = await searchParams;
  const [systems, selectedId, savedBaseUrl] = await Promise.all([
    listSystems(),
    getSelectedSystemId(),
    add === "connect" && id ? getSavedBaseUrl(id) : undefined,
  ]);
  return (
    <SystemList items={systems} selectedId={selectedId} savedBaseUrl={savedBaseUrl} />
  );
}
