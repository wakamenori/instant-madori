import { attachmentLimits } from "./attachments.ts";

export type PreparedImage = { blob: Blob };

export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, attachmentLimits.maxEdgePx / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas =
      typeof OffscreenCanvas === "undefined"
        ? document.createElement("canvas")
        : new OffscreenCanvas(width, height);
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context || !("drawImage" in context)) throw new Error("Cannot draw the image");
    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    // Encoding the drawn pixels strips EXIF, including location data.
    const blob =
      "convertToBlob" in canvas
        ? await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })
        : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (blob?.type !== "image/jpeg") throw new Error("Cannot encode the image as JPEG");
    return { blob };
  } finally {
    bitmap.close();
  }
}
