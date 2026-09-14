"use client";

import { useEffect } from "react";
import { startDiagnostics } from "@/lib/diag/collector";

/**
 * Starts the diagnostic collector for the whole app.
 *
 * Renders nothing. Mounted once in the root layout so the hooks are installed
 * before any screen runs — a collector mounted per-route would miss the errors
 * thrown while that route was still loading, which is when a good share of them
 * happen.
 *
 * `startDiagnostics` guards against running twice, which matters here: React
 * runs effects twice in development, and a second pass would wrap the already
 * wrapped `console.error` and record everything two times over.
 */
export function DiagnosticsMount() {
    useEffect(() => {
        startDiagnostics();
    }, []);
    return null;
}
