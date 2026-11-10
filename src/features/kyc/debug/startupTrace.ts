/**
 * DEV ONLY — a timeline of the face step's startup, to find what freezes the
 * camera. Every line is `[face-startup] +<ms since first mark> <label>`, and
 * every main-thread block over 50ms (a "long task") is logged with its length
 * and when it started, so the freeze can be matched to the step that caused it.
 *
 * Browser console output reaches the dev server's log, so a single run of the
 * face step is enough to read the whole sequence back. Does nothing in
 * production.
 */

const enabled = process.env.NODE_ENV !== "production" && typeof window !== "undefined";

let origin: number | null = null;
let observing = false;

function since(at: number): string {
    return `+${Math.round(at - (origin ?? at))}ms`;
}

export function traceFaceStartup(label: string): void {
    if (!enabled) return;
    const now = performance.now();
    if (origin === null) origin = now;
    console.log(`[face-startup] ${since(now)} ${label}`);

    if (observing || typeof PerformanceObserver === "undefined") return;
    observing = true;
    try {
        new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                console.log(
                    `[face-startup] ${since(entry.startTime)} LONG TASK ${Math.round(entry.duration)}ms`,
                );
            }
        }).observe({ type: "longtask", buffered: true });
    } catch {
        // No long-task support (Safari, Firefox): the labels alone still help.
    }
}
