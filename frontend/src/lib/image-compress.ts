// Allegement d'une image sur l'appareil, avant son enregistrement comme piece
// jointe : reduction des dimensions puis recompression.

/** Au-dela de ce poids, l'editeur propose d'alleger l'image. */
export const HEAVY_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_SIDE = 2000;
const QUALITY = 0.85;

export function isHeavyImage(file: File): boolean {
  return file.type.startsWith("image/") && file.type !== "image/gif" && file.type !== "image/svg+xml" && file.size > HEAVY_IMAGE_BYTES;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function hasAlpha(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  // Echantillonnage : suffit a distinguer une capture opaque d'un logo detoure.
  const data = ctx.getImageData(0, 0, w, h).data;
  const step = Math.max(4, Math.floor(data.length / 4 / 20000) * 4);
  for (let i = 3; i < data.length; i += step) if (data[i] < 255) return true;
  return false;
}

/**
 * Rend une version allegee de l'image, ou l'original si l'allegement ne
 * fait rien gagner (ou si le navigateur ne sait pas la decoder).
 */
export async function compressImage(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const transparent = file.type === "image/png" || file.type === "image/webp" ? hasAlpha(ctx, w, h) : false;
    const type = transparent ? "image/webp" : "image/jpeg";
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, QUALITY));
    if (!blob || blob.size >= file.size) return file;
    const base = file.name.replace(/\.[^.]+$/, "") || "image";
    return new File([blob], `${base}.${type === "image/webp" ? "webp" : "jpg"}`, { type, lastModified: Date.now() });
  } catch {
    return file;
  }
}

