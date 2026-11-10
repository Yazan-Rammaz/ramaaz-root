"use client";

import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, Reorder, motion } from "motion/react";
import { useLocale, useTranslations } from "next-intl";
import { iosEase } from "@/components/motion/presets";
import { DashedFrame } from "@/components/ui/DashedFrame";
import { FormError } from "@/components/ui/FormError";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils/cn";
import { useAddAction } from "@/features/shell/add-action";
import { reorderRolesAction } from "../actions";
import {
  permissionChip,
  type Permission,
  type Role,
  type RoleCountry,
} from "../schema";
import { useRoleWrite } from "../use-role-write";
import { PermissionPanel } from "./PermissionPanel";
import { RolePanel, pickRoleName } from "./RolePanel";
import type { NameLanguage } from "@/features/language/names";

const BLUE = {
  "--hairline-radius": "0.75rem",
  "--hairline-color": "#388cff",
} as CSSProperties;

/**
 * "System RBAC" (XD, task 2026-11-05), two tabs. **Roles**: the project's roles in rank
 * order — badge + name — and the right panel for the selected one. The navbar
 * "+" opens a new role (`?add=role`, as on Regions).
 *
 * The order IS the ranking (the top role is the most senior; later, a person
 * can only give roles below their own). Rows are dragged into a new order,
 * then saved in one call — after a confirmation, since it changes who may
 * appoint whom — and the list is redrawn from the answer.
 *
 * **Permissions**: the project's catalog, read-only — the project publishes
 * its permissions and the console cannot change them (`PermissionPanel`).
 *
 * Seeded from the server; a newer server list (after `router.refresh()`,
 * when another Root changed something) replaces the local one.
 */
type Tab = "roles" | "permissions";

export function RoleList({
  roles: initial,
  catalog,
  permissions,
  countries,
  languages,
}: {
  roles: Role[];
  /** The whole catalog, for the Permissions tab. */
  catalog: Permission[];
  /** What a role may hold (no root-only, no retired), for the role panel. */
  permissions: Permission[];
  countries: RoleCountry[];
  /** The project's languages — a role's name rows, the same as every name form. */
  languages: NameLanguage[];
}) {
  const t = useTranslations("rbac");
  const locale = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const sortWrite = useRoleWrite();

  const [roles, setRoles] = useState(initial);
  const [order, setOrder] = useState(() => initial.map((r) => r.id));
  const [selectedId, setSelectedId] = useState<string | null>(
    initial[0]?.id ?? null,
  );
  const [confirmSort, setConfirmSort] = useState(false);
  // The sub-tab is client state, as on Regions; only "add" is in the URL.
  const [tab, setTab] = useState<Tab>("roles");
  const [selectedKey, setSelectedKey] = useState<string | null>(
    catalog[0]?.key ?? null,
  );
  // A newer list from the server wins (React's pattern for resetting state on a prop change).
  const [seed, setSeed] = useState(initial);
  if (seed !== initial) {
    setSeed(initial);
    setRoles(initial);
    setOrder(initial.map((r) => r.id));
    setConfirmSort(false);
    if (!initial.some((r) => r.id === selectedId))
      setSelectedId(initial[0]?.id ?? null);
  }

  const adding = params.get("add") === "role";
  const closeAdd = () => router.replace("/roles");
  const selected = adding
    ? null
    : (roles.find((r) => r.id === selectedId) ?? null);
  const selectedPermission = catalog.find((p) => p.key === selectedKey) ?? null;
  const panelOpen =
    tab === "roles" ? adding || selected != null : selectedPermission != null;
  const byId = new Map(roles.map((r) => [r.id, r]));
  const sorted = order
    .map((id) => byId.get(id))
    .filter((r): r is Role => r != null);
  const orderChanged = order.join() !== roles.map((r) => r.id).join();

  // The navbar "+" opens a new role (the catalog has nothing to add); its
  // "Close" closes the panel.
  const { setHref, setOnClose, setHideAdd } = useAddAction();
  useEffect(() => {
    setHref(tab === "roles" ? "/roles?add=role" : null);
    // The catalog is read-only: no "+" at all on its tab.
    setHideAdd(tab === "permissions");
    return () => {
      setHref(null);
      setHideAdd(false);
    };
  }, [tab, setHref, setHideAdd]);
  useEffect(() => {
    if (!panelOpen) return;
    setOnClose(() =>
      tab === "permissions"
        ? setSelectedKey(null)
        : adding
          ? closeAdd()
          : setSelectedId(null),
    );
    return () => setOnClose(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closeAdd is a fresh closure over the stable router
  }, [panelOpen, adding, tab, setOnClose]);

  function switchTab(next: Tab) {
    if (adding) closeAdd();
    setTab(next);
  }

  async function saveOrder() {
    if (!confirmSort) return setConfirmSort(true);
    setConfirmSort(false);
    const r = await sortWrite.run(() => reorderRolesAction(order));
    if (r?.roles) {
      setRoles(r.roles);
      setOrder(r.roles.map((x) => x.id));
    } else if (r?.reload) router.refresh();
  }

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="flex items-stretch gap-4 ps-12 pe-12">
          <span
            className="hairline flex h-106 w-50 shrink-0 items-center justify-center rad-12 bg-surface"
            style={BLUE}
          >
            <Icon name="nav/hierarchy" size={26} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-6">
            {/* Tabs: Roles, Permissions — the selected one framed in blue. */}
            <div className="flex h-50 items-center gap-4 rad-12 bg-surface">
              {(["roles", "permissions"] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => switchTab(id)}
                  aria-label={t(`tabs.${id}`)}
                  aria-pressed={tab === id}
                  style={tab === id ? BLUE : undefined}
                  className={cn(
                    "flex h-50 w-50 shrink-0 items-center justify-center rad-12 text-ink",
                    tab === id && "hairline",
                  )}
                >
                  <Icon
                    name={id === "roles" ? "roles/tab-roles" : "roles/tab-tree"}
                    size={id === "roles" ? 24 : 22}
                    mask
                  />
                </button>
              ))}
            </div>
            <span className="flex h-50 items-center rad-12 bg-surface ps-12">
              <span className="fz-14 font-light text-ink">
                {t("title")} |{" "}
                <span className="font-medium">{t(`tabs.${tab}`)}</span>
              </span>
            </span>
          </div>
        </header>

        {tab === "permissions" ? (
          catalog.length === 0 ? (
            <p className="mt-12 ps-12 fz-14 text-muted">{t("catalog.empty")}</p>
          ) : (
            <ul className="mt-12 flex flex-col gap-4 ps-12">
              {catalog.map((p) => (
                <li key={p.key} className="flex gap-4">
                  <span className="flex h-50 w-50 shrink-0 items-center justify-center rad-12 bg-surface fz-14 text-ink">
                    {permissionChip(p.key)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedKey(p.key)}
                    aria-pressed={p.key === selectedKey}
                    style={p.key === selectedKey ? BLUE : undefined}
                    className={cn(
                      "flex h-50 w-352 max-w-full items-center rad-12 bg-surface ps-12 text-start",
                      p.key === selectedKey && "hairline",
                      p.status === "RETIRED" && "opacity-50",
                    )}
                  >
                    <span className="truncate fz-14 text-ink">
                      {pickRoleName(p.label, locale) || p.key}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : sorted.length === 0 ? (
          <p className="mt-12 ps-12 fz-14 text-muted">{t("empty")}</p>
        ) : (
          <Reorder.Group
            axis="y"
            values={order}
            onReorder={(next) => {
              setOrder(next);
              setConfirmSort(false);
              sortWrite.reset();
            }}
            className="mt-12 flex flex-col gap-4 ps-12"
          >
            {sorted.map((r) => (
              <Reorder.Item
                key={r.id}
                value={r.id}
                className="flex cursor-grab gap-4 active:cursor-grabbing"
              >
                <span className="flex h-50 w-50 shrink-0 items-center justify-center rad-12 bg-surface fz-14 text-ink">
                  {r.short_name}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (adding) closeAdd();
                    setSelectedId(r.id);
                  }}
                  aria-pressed={!adding && r.id === selectedId}
                  style={!adding && r.id === selectedId ? BLUE : undefined}
                  className={cn(
                    "flex h-50 w-352 max-w-full items-center rad-12 bg-surface ps-12 text-start",
                    !adding && r.id === selectedId && "hairline",
                  )}
                >
                  <span className="truncate fz-14 text-ink">
                    {pickRoleName(r.name, locale)}
                  </span>
                </button>
              </Reorder.Item>
            ))}
          </Reorder.Group>
        )}

        {/* A new order waits here until it is saved — one call for the whole list. */}
        {tab === "roles" && (orderChanged || sortWrite.result.error) && (
          <div className="mt-12 flex w-406 max-w-full flex-col gap-8 ps-12">
            {orderChanged && (
              <>
                <span className="fz-12 text-ink">
                  {confirmSort ? t("sort.confirm") : t("sort.changed")}
                </span>
                <div className="flex gap-8">
                  <button
                    type="button"
                    onClick={() => {
                      setOrder(roles.map((r) => r.id));
                      setConfirmSort(false);
                    }}
                    disabled={sortWrite.busy}
                    className="h-50 w-110 shrink-0 rad-12 bg-surface fz-14 font-medium text-ink disabled:opacity-50"
                  >
                    {t("sort.undo")}
                  </button>
                  <button
                    type="button"
                    onClick={saveOrder}
                    disabled={sortWrite.busy}
                    aria-busy={sortWrite.busy}
                    className="h-50 flex-1 rad-12 bg-ink fz-14 font-medium text-white disabled:opacity-50"
                  >
                    {confirmSort ? t("save.confirm") : t("sort.save")}
                  </button>
                </div>
              </>
            )}
            <FormError
              message={sortWrite.result.error}
              attempt={sortWrite.result}
            />
          </div>
        )}
      </div>

      <AnimatePresence>
        {panelOpen && (
          <motion.aside
            initial={{ x: "100%", opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: "100%", opacity: 0 }}
            transition={iosEase}
            className="relative flex h-full w-430 max-w-full shrink-0 flex-col bg-background"
            aria-label={
              tab === "permissions"
                ? (selectedPermission?.key ?? "")
                : selected
                  ? pickRoleName(selected.name, locale)
                  : t("newRole")
            }
          >
            <DashedFrame radius={20} color="#8d8d8d" />
            {tab === "permissions" && selectedPermission ? (
              <PermissionPanel
                key={selectedPermission.key}
                permission={selectedPermission}
                roles={roles}
              />
            ) : (
              <RolePanel
                key={selected?.id ?? "new"}
                role={selected}
                permissions={permissions}
                countries={countries}
                languages={languages}
                onSaved={(saved) => {
                  const exists = roles.some((r) => r.id === saved.id);
                  // A new role is the most junior: it goes last.
                  setRoles((rs) =>
                    exists
                      ? rs.map((r) => (r.id === saved.id ? saved : r))
                      : [...rs, saved],
                  );
                  if (!exists) setOrder((o) => [...o, saved.id]);
                  if (adding) closeAdd();
                  setSelectedId(saved.id);
                }}
                onDeleted={(id) => {
                  const at = order.indexOf(id);
                  const rest = order.filter((x) => x !== id);
                  setRoles((rs) => rs.filter((r) => r.id !== id));
                  setOrder(rest);
                  // Its neighbour takes the selection.
                  setSelectedId(rest[Math.min(at, rest.length - 1)] ?? null);
                }}
                onReload={() => router.refresh()}
              />
            )}
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}
