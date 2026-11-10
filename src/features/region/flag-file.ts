"use client";

import { FLAG_CODES } from "./flag-codes";
import { toAlpha2 } from "./mock-geo";
import { FLAG_TYPES, MAX_FLAG_BYTES, type FlagFile } from "./schema";

/**
 * Turning a flag into what RDB's `media.upload` takes (answers 2026-10-31 §1):
 * standard base64 with padding, its real type, at most 256 KB — checked here,
 * before anything is sent, so the person hears about a wrong file at once.
 *
 * Two sources, one shape: a file the person picked, or our bundled flag for
 * the country's ISO code (`/public/icons/flags`), which is the default — so a
 * country needs no upload unless someone wants a different flag.
 */

export type PickedFlag = {
  file: FlagFile;
  /** For the preview box: the same bytes as a `data:` URL (CSP allows `data:` images). */
  preview: string;
};

export type FlagProblem = "type" | "size" | "missing";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // In slices: one `fromCharCode` over a whole file overflows the call stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBytes(bytes: Uint8Array, contentType: FlagFile["contentType"]): PickedFlag | FlagProblem {
  if (bytes.length === 0) return "missing";
  if (bytes.length > MAX_FLAG_BYTES) return "size";
  const data = toBase64(bytes);
  return { file: { contentType, data }, preview: `data:${contentType};base64,${data}` };
}

/** A file the person picked. */
export async function readPickedFlag(file: File): Promise<PickedFlag | FlagProblem> {
  const type = (FLAG_TYPES as readonly string[]).includes(file.type)
    ? (file.type as FlagFile["contentType"])
    : null;
  if (!type) return "type";
  if (file.size > MAX_FLAG_BYTES) return "size";
  return fromBytes(new Uint8Array(await file.arrayBuffer()), type);
}

/** Our bundled flag for an ISO code — null when the set has none. */
export async function readBundledFlag(code: string): Promise<PickedFlag | null> {
  const cc = toAlpha2(code).toLowerCase();
  if (!FLAG_CODES.has(cc)) return null;
  try {
    // A static file on our own origin — not a backend call.
    const res = await fetch(`/icons/flags/${cc}.svg`);
    if (!res.ok) return null;
    const picked = fromBytes(new Uint8Array(await res.arrayBuffer()), "image/svg+xml");
    return typeof picked === "string" ? null : picked;
  } catch {
    return null;
  }
}
