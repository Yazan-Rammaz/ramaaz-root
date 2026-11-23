/*
 * Shown the moment a page in the dashboard is opened, while the server reads it
 * (2026-11-24): the sidebar and navbar stay, the content area shows rows shaped
 * like the screens' own lists, sweeping. It used to show nothing — the old page
 * just stood there until the new one had loaded everything.
 */
export default function DashboardLoading() {
    return (
        <div aria-busy className="flex h-full flex-col gap-6 p-12">
            {Array.from({ length: 7 }, (_, i) => (
                <div key={i} aria-hidden className="flex gap-4">
                    <span className="bg-surface rad-12 grid h-50 w-50 shrink-0 place-items-center">
                        <span className="skeleton block h-14 w-20 rad-5" />
                    </span>
                    <span className="bg-surface rad-12 flex h-50 flex-1 items-center px-12">
                        <span className={`skeleton block h-8 rad-5 ${i % 3 === 0 ? 'w-200' : i % 3 === 1 ? 'w-140' : 'w-170'}`} />
                    </span>
                </div>
            ))}
        </div>
    );
}
