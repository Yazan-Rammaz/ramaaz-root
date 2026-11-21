import type { NextRequest } from "next/server";
import { z } from "zod";
import { readAllPages, readOperation } from "@/lib/api/operations";
import { proxyImage } from "@/lib/api/proxy-image";

/**
 * A country's or region's map as RDB keeps it (`mapImageUrl`), from our own
 * origin (see `proxyImage`): the browser never addresses RDB, and the CSP
 * allows only our own images.
 *
 *   ?country={id}                 the country's map
 *   ?country={id}&region={id}     a region's map, read from its country's regions
 *
 * The request names only WHICH map; the URL is the one RDB answers, read here
 * with the caller's own session.
 */

export const dynamic = "force-dynamic";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const mapped = z.object({ id: z.string(), mapImageUrl: z.string().nullable().optional() }).loose();

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const country = id.safeParse(params.get("country"));
  const region = params.get("region") ? id.safeParse(params.get("region")) : null;
  let url: string | null | undefined;
  try {
    if (country.success && !region) {
      url = mapped.parse(await readOperation("country.get", { params: { id: country.data } })).mapImageUrl;
    } else if (country.success && region?.success) {
      const rows = z.array(mapped).parse(await readAllPages("region.list", { params: { unit_id: country.data } }));
      url = rows.find((r) => r.id === region.data)?.mapImageUrl;
    }
  } catch (error) {
    console.warn("[geo-map] read failed:", error instanceof Error ? error.message : error);
  }
  return proxyImage(url ?? undefined, "geo-map");
}
