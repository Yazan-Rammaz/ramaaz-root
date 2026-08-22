import { listSystems } from "@/features/system/api";
import { SystemList } from "@/features/system/components/SystemList";
import { getSelectedSystemId } from "@/lib/api/backend";

/**
 * Systems — the "System Projects" list. Renders inside the (dashboard) shell
 * (sidebar + navbar); the layout already provides the <main> scroll region and
 * the requireSession() gate, so this page stays thin. Clicking a system
 * selects it — project pages then talk to that system's backend.
 */
export default async function SystemsPage() {
  const [systems, selectedId] = await Promise.all([
    listSystems(),
    getSelectedSystemId(),
  ]);
  return <SystemList items={systems} selectedId={selectedId} />;
}
