import { put } from "@vercel/blob";

export type MediaUploadInput = {
  sourceUrl?: string;
  dataUrl?: string;
  base64Data?: string;
  mimeType?: string;
  fileName?: string;
};

const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
]);

function safeFileName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

function extensionFor(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "video/quicktime") return "mov";
  return "mp4";
}

function assertAllowed(mimeType: string, size: number) {
  if (!ALLOWED_TYPES.has(mimeType)) {
    throw new Error("Yalniz JPG, PNG, WebP, MP4 ve MOV dosyalari yuklenebilir.");
  }
  if (size <= 0) throw new Error("Medya dosyasi bos.");
  if (size > MAX_BYTES) throw new Error("Medya dosyasi en fazla 15 MB olabilir.");
}

function decodeInline(input: MediaUploadInput) {
  if (input.dataUrl) {
    const match = input.dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
    if (!match) throw new Error("Gecersiz data URL.");
    return { mimeType: match[1].toLowerCase(), buffer: Buffer.from(match[2], "base64") };
  }

  if (input.base64Data) {
    if (!input.mimeType) throw new Error("base64Data ile mimeType zorunludur.");
    return {
      mimeType: input.mimeType.toLowerCase(),
      buffer: Buffer.from(input.base64Data.replace(/\s/g, ""), "base64"),
    };
  }

  return null;
}

async function downloadSource(sourceUrl: string) {
  const url = new URL(sourceUrl);
  if (url.protocol !== "https:") throw new Error("Kaynak URL HTTPS olmali.");
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())) {
    throw new Error("Yerel adreslerden medya yuklenemez.");
  }

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Medya indirilemedi (HTTP ${response.status}).`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_BYTES) throw new Error("Medya dosyasi en fazla 15 MB olabilir.");

  const mimeType = (response.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());
  return { mimeType, buffer };
}

export async function uploadInstagramMedia(input: MediaUploadInput) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("BLOB_READ_WRITE_TOKEN MCP ortaminda tanimlanmali.");
  }

  const inline = decodeInline(input);
  const media = inline || (input.sourceUrl ? await downloadSource(input.sourceUrl) : null);
  if (!media) {
    throw new Error("sourceUrl, dataUrl veya base64Data alanlarindan biri gerekli.");
  }

  assertAllowed(media.mimeType, media.buffer.length);
  const preferredName = safeFileName(input.fileName || "claude-instagram-media");
  const extension = extensionFor(media.mimeType);
  const nameWithoutExtension = preferredName.replace(/\.[a-zA-Z0-9]+$/, "") || "media";
  const pathname = `claude-instagram/${Date.now()}-${nameWithoutExtension}.${extension}`;

  const blob = await put(pathname, media.buffer, {
    access: "public",
    contentType: media.mimeType,
    addRandomSuffix: true,
  });

  return {
    ok: true,
    publicUrl: blob.url,
    downloadUrl: blob.downloadUrl,
    mimeType: media.mimeType,
    sizeBytes: media.buffer.length,
    readyForInstagram: true,
  };
}
