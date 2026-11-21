import { redirect } from "next/navigation";
import { loadDataSettings, loadLevel, loadStructure } from "@/features/work-structure/api";
import { WorkStructureScreen } from "@/features/work-structure/components/WorkStructureScreen";
import { idSchema } from "@/features/work-structure/schema";
import { getSelectedSystem } from "@/lib/api/backend";
import { cfEnv } from "@/lib/cf-env";

/** "https://canmgt.example.dev/" → "canmgt.example.dev" — the Dashboard Link as the design writes it. */
function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Business Work Structure — the selected project's organisation and the
 * people who run each level of it. Renders inside the (dashboard) shell; the
 * layout provides the <main> scroll region and the requireSession() gate, so
 * this page stays thin. Nothing selected → back to the systems list.
 *
 * `?level=head` opens the head office, `?level={unitId}` a unit; without it
 * only the tree shows. The panel is read here, so every write on it ends in
 * `router.refresh()` and this reads it again.
 */
export default async function WorkStructurePage({
  searchParams,
}: {
  searchParams: Promise<{ level?: string }>;
}) {
  const system = await getSelectedSystem();
  if (!system) redirect("/systems");

  const { level: raw } = await searchParams;
  const structure = await loadStructure();
  const unit = raw && raw !== "head" && idSchema.safeParse(raw).success ? raw : undefined;
  const level = raw === "head" ? null : unit && structure.units.some((u) => u.id === unit) ? unit : undefined;

  const [panel, data] = await Promise.all([
    level === undefined ? Promise.resolve(null) : loadLevel(level, structure.units),
    level === undefined ? Promise.resolve(null) : loadDataSettings(level, structure.units),
  ]);

  return (
    <WorkStructureScreen
      projectName={system.name}
      managementUrl={hostOf(cfEnv("MANAGEMENT_URL"))}
      structure={structure}
      panel={panel}
      data={data}
    />
  );
}
