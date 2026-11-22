import type { NextRequest } from "next/server";
import { getLoginApproval, getMemberVerification, memberPhotoUrl } from "@/features/work-structure/api";
import { EVIDENCE_IMAGES, idSchema, type EvidenceImage } from "@/features/work-structure/schema";
import { proxyImage } from "@/lib/api/proxy-image";

/**
 * The work structure's pictures, from our own origin (see `proxyImage`):
 *
 *   ?member={userId}                     their reference photograph (§5.9)
 *   ?approval={id}&image=reference|capture|front|back
 *   ?verification={userId}&image=reference|capture|front|back
 *                                        a member's passed verification (the Files tab)
 *                                        a first sign-in's evidence (§5.12)
 *
 * The request names only WHICH picture; the URL is always the one the
 * backend hands out for it, read fresh here with the caller's own session —
 * so it shows nothing the caller could not read through the API, and a
 * signed URL is never kept anywhere.
 */

export const dynamic = "force-dynamic";

const EVIDENCE: Record<EvidenceImage, (a: Awaited<ReturnType<typeof getLoginApproval>>) => string | null | undefined> = {
  reference: (a) => a.evidence?.reference_photo_url,
  capture: (a) => a.evidence?.face_capture_url,
  front: (a) => a.evidence?.document?.front_image_url,
  back: (a) => a.evidence?.document?.back_image_url,
};

const VERIFICATION: Record<EvidenceImage, (v: Awaited<ReturnType<typeof getMemberVerification>>) => string | null | undefined> = {
  reference: (v) => v.reference_photo_url,
  capture: (v) => v.face_capture?.image_url,
  front: (v) => v.document?.front_image_url,
  back: (v) => v.document?.back_image_url,
};

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const member = idSchema.safeParse(params.get("member"));
  const approval = idSchema.safeParse(params.get("approval"));
  const verification = idSchema.safeParse(params.get("verification"));
  const image = params.get("image");

  let url: string | null | undefined;
  try {
    if (member.success) url = await memberPhotoUrl(member.data);
    else if (approval.success && EVIDENCE_IMAGES.includes(image as EvidenceImage)) {
      url = EVIDENCE[image as EvidenceImage](await getLoginApproval(approval.data));
    } else if (verification.success && EVIDENCE_IMAGES.includes(image as EvidenceImage)) {
      url = VERIFICATION[image as EvidenceImage](await getMemberVerification(verification.data));
    }
  } catch (error) {
    console.warn("[work-image] lookup failed:", error instanceof Error ? error.message : error);
  }
  return proxyImage(url ?? undefined, "work-image");
}
