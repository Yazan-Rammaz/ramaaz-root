/**
 * A picked image file → a JPEG data URL small enough to send.
 *
 * The backend takes a data URL of at most 2 MiB (console-api.md §5.9), but a
 * Server Action takes 1 MB, so the picture is redrawn at no more than 1024 px
 * on its long side — plenty for a face match — and as a JPEG, so its type
 * always matches what the data URL says. Browser-only.
 */
export async function photoToDataUrl(file: File, maxSide = 1024): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    // A transparent PNG would turn black as a JPEG.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const q of [0.85, 0.7, 0.55]) {
      const url = canvas.toDataURL("image/jpeg", q);
      if (url.length < 900_000) return url;
    }
    throw new Error("photo too large");
  } finally {
    bitmap.close();
  }
}

/** The member's reference photograph, through our origin (`/api/work-image`). */
export const memberPhotoSrc = (userId: string, version = 0) =>
  `/api/work-image?member=${encodeURIComponent(userId)}${version ? `&v=${version}` : ""}`;

/** One picture of a first sign-in's evidence. */
export const evidenceSrc = (approvalId: string, image: "reference" | "capture" | "front" | "back") =>
  `/api/work-image?approval=${encodeURIComponent(approvalId)}&image=${image}`;
