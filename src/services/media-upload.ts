import { del, put } from "@vercel/blob";

export type MediaUploadInput = {
  sourceUrl?: string;
  dataUrl?: string;
  base64Data?: string;
  mimeType?: string;
  fileName?: string;
};

export type MediaChunkInput = {
  uploadId: string;
  chunkIndex: number;
  totalChunks: number;
  base64Chunk: string;
};

export type CompleteMediaUploadInput = {
  uploadId: string;
  chunkUrls: string[];
  mimeType: string;
  fileName?: string;
};

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_CHUNK_BASE64_CHARS = 750_000;
const MAX_CHUNKS = 40;
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

function assertBlobConfigured() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("BLOB_READ_WRITE_TOKEN MCP ortaminda tanimlanmali.");
  }
}

function safeUploadId(value: string) {
  const uploadId = safeFileName(value);
  if (!uploadId || uploadId.length < 6) {
    throw new Error("uploadId en az 6 karakter olmali.");
  }
  return uploadId;
}

function isVercelBlobUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
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
  assertBlobConfigured();

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

export async function uploadInstagramMediaChunk(input: MediaChunkInput) {
  assertBlobConfigured();
  const uploadId = safeUploadId(input.uploadId);
  if (!Number.isInteger(input.chunkIndex) || input.chunkIndex < 0) {
    throw new Error("chunkIndex 0 veya daha buyuk bir tam sayi olmali.");
  }
  if (!Number.isInteger(input.totalChunks) || input.totalChunks < 1 || input.totalChunks > MAX_CHUNKS) {
    throw new Error(`totalChunks 1-${MAX_CHUNKS} arasinda olmali.`);
  }
  if (input.chunkIndex >= input.totalChunks) throw new Error("chunkIndex totalChunks degerinden kucuk olmali.");

  const normalized = String(input.base64Chunk || "").replace(/\s/g, "");
  if (!normalized || normalized.length > MAX_CHUNK_BASE64_CHARS) {
    throw new Error(`Her base64 parcasi en fazla ${MAX_CHUNK_BASE64_CHARS} karakter olmali.`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) throw new Error("Gecersiz base64 parcasi.");

  const buffer = Buffer.from(normalized, "base64");
  if (!buffer.length) throw new Error("Medya parcasi bos.");
  const index = String(input.chunkIndex).padStart(3, "0");
  const blob = await put(`claude-instagram/chunks/${uploadId}/${index}.part`, buffer, {
    access: "public",
    contentType: "application/octet-stream",
    addRandomSuffix: true,
  });

  return {
    ok: true,
    uploadId,
    chunkIndex: input.chunkIndex,
    totalChunks: input.totalChunks,
    chunkUrl: blob.url,
    sizeBytes: buffer.length,
    nextChunkIndex: input.chunkIndex + 1 < input.totalChunks ? input.chunkIndex + 1 : null,
    readyToComplete: input.chunkIndex + 1 === input.totalChunks,
  };
}

export async function completeInstagramMediaUpload(input: CompleteMediaUploadInput) {
  assertBlobConfigured();
  const uploadId = safeUploadId(input.uploadId);
  const mimeType = String(input.mimeType || "").toLowerCase();
  if (!ALLOWED_TYPES.has(mimeType)) {
    throw new Error("Yalniz JPG, PNG, WebP, MP4 ve MOV dosyalari birlestirilebilir.");
  }
  if (!Array.isArray(input.chunkUrls) || !input.chunkUrls.length || input.chunkUrls.length > MAX_CHUNKS) {
    throw new Error(`chunkUrls 1-${MAX_CHUNKS} URL icermeli.`);
  }
  if (input.chunkUrls.some((url) => !isVercelBlobUrl(url))) {
    throw new Error("Tum parca URL'leri bu uygulamanin Vercel Blob adresleri olmali.");
  }

  const buffers: Buffer[] = [];
  let totalBytes = 0;
  for (const chunkUrl of input.chunkUrls) {
    const response = await fetch(chunkUrl);
    if (!response.ok) throw new Error(`Medya parcasi indirilemedi (HTTP ${response.status}).`);
    const buffer = Buffer.from(await response.arrayBuffer());
    totalBytes += buffer.length;
    if (totalBytes > MAX_BYTES) throw new Error("Birlesik medya dosyasi en fazla 15 MB olabilir.");
    buffers.push(buffer);
  }

  const media = Buffer.concat(buffers);
  assertAllowed(mimeType, media.length);
  const preferredName = safeFileName(input.fileName || "claude-instagram-media");
  const extension = extensionFor(mimeType);
  const nameWithoutExtension = preferredName.replace(/\.[a-zA-Z0-9]+$/, "") || "media";
  const blob = await put(`claude-instagram/${Date.now()}-${uploadId}-${nameWithoutExtension}.${extension}`, media, {
    access: "public",
    contentType: mimeType,
    addRandomSuffix: true,
  });

  await del(input.chunkUrls).catch(() => undefined);
  return {
    ok: true,
    publicUrl: blob.url,
    downloadUrl: blob.downloadUrl,
    mimeType,
    sizeBytes: media.length,
    chunksCombined: input.chunkUrls.length,
    readyForInstagram: true,
  };
}
