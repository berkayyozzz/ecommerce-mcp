import { createHash } from "node:crypto";

export type InstagramPostType = "image" | "carousel" | "reel" | "story";

export type InstagramPostInput = {
  type: InstagramPostType;
  caption: string;
  mediaUrls: string[];
  altText?: string;
};

const FINAL_APPROVAL = "SON ONAY: YAYINLA";

function config() {
  const igUserId = process.env.META_IG_USER_ID || process.env.INSTAGRAM_ACCOUNT_ID;
  const accessToken = process.env.META_ACCESS_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN;
  const apiVersion = process.env.META_API_VERSION || "v25.0";
  const baseUrl = (process.env.META_GRAPH_BASE_URL || "https://graph.facebook.com").replace(/\/$/, "");
  if (!igUserId || !accessToken) {
    throw new Error("META_IG_USER_ID ve META_ACCESS_TOKEN Render environment alaninda tanimlanmali.");
  }
  return { igUserId, accessToken, apiVersion, baseUrl };
}

function validatePublicHttpsUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Media URL HTTPS olmali.");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    throw new Error("Media URL internetten erisilebilir olmali.");
  }
  return url.toString();
}

export function normalizeInstagramPost(input: InstagramPostInput): InstagramPostInput {
  if (!["image", "carousel", "reel", "story"].includes(input.type)) {
    throw new Error("Gecersiz Instagram icerik tipi.");
  }

  const mediaUrls = (input.mediaUrls || []).map(validatePublicHttpsUrl);
  if (!mediaUrls.length) throw new Error("En az bir public HTTPS media URL gerekli.");
  if (input.type === "carousel" && (mediaUrls.length < 2 || mediaUrls.length > 10)) {
    throw new Error("Carousel 2 ile 10 gorsel icermeli.");
  }
  if (input.type !== "carousel" && mediaUrls.length !== 1) {
    throw new Error(`${input.type} icin tam olarak bir media URL gerekli.`);
  }

  const caption = String(input.caption || "").trim();
  if (input.type !== "story" && !caption) throw new Error("Caption bos olamaz.");

  return {
    type: input.type,
    caption,
    mediaUrls,
    altText: input.altText?.trim() || undefined,
  };
}

export function previewInstagramPost(input: InstagramPostInput) {
  const normalized = normalizeInstagramPost(input);
  const previewHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  return {
    accountId: process.env.META_IG_USER_ID || process.env.INSTAGRAM_ACCOUNT_ID || "NOT_CONFIGURED",
    ...normalized,
    previewHash,
    approvalRequired: FINAL_APPROVAL,
    warning: "Bu onizleme kullanici tarafindan acikca onaylanmadan yayin aracini cagirmayin.",
  };
}

async function graphGet<T>(path: string, params: Record<string, string>) {
  const { accessToken, apiVersion, baseUrl } = config();
  const url = new URL(`${baseUrl}/${apiVersion}/${path.replace(/^\//, "")}`);
  Object.entries({ ...params, access_token: accessToken }).forEach(([key, value]) =>
    url.searchParams.set(key, value),
  );
  const response = await fetch(url);
  const body = (await response.json()) as { error?: { message?: string } } & T;
  if (!response.ok) throw new Error(body.error?.message || `Meta API HTTP ${response.status}`);
  return body;
}

async function graphPost<T>(path: string, params: Record<string, string>) {
  const { accessToken, apiVersion, baseUrl } = config();
  const response = await fetch(`${baseUrl}/${apiVersion}/${path.replace(/^\//, "")}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, access_token: accessToken }),
  });
  const body = (await response.json()) as { error?: { message?: string } } & T;
  if (!response.ok) throw new Error(body.error?.message || `Meta API HTTP ${response.status}`);
  return body;
}

async function createContainer(params: Record<string, string>) {
  return graphPost<{ id: string }>(`${config().igUserId}/media`, params);
}

async function publishContainer(creationId: string) {
  return graphPost<{ id: string }>(`${config().igUserId}/media_publish`, { creation_id: creationId });
}

async function waitForContainer(creationId: string) {
  const timeoutMs = Math.max(
    60_000,
    Number(process.env.INSTAGRAM_VIDEO_PROCESSING_TIMEOUT_MS || 600_000),
  );
  const pollIntervalMs = 3_000;
  const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await graphGet<{ status_code?: string; status?: string }>(creationId, {
      fields: "status_code,status",
    });
    if (result.status_code === "FINISHED") return;
    if (result.status_code === "ERROR" || result.status_code === "EXPIRED") {
      throw new Error(result.status || `Instagram container durumu: ${result.status_code}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error("Instagram video hazirligi zaman asimina ugradi.");
}

export async function getInstagramAccount() {
  const { igUserId } = config();
  return graphGet<{ id: string; username?: string; name?: string }>(igUserId, {
    fields: "id,username,name",
  });
}

export async function publishInstagramPost(input: InstagramPostInput & {
  previewHash: string;
  approval: string;
}) {
  if (input.approval !== FINAL_APPROVAL) {
    throw new Error(`Yayin icin kullanici tam olarak \"${FINAL_APPROVAL}\" yazmalidir.`);
  }
  const preview = previewInstagramPost(input);
  if (preview.previewHash !== input.previewHash) {
    throw new Error("Icerik onizlemeden sonra degismis. Yeniden onizleme ve kullanici onayi gerekli.");
  }

  if (preview.type === "carousel") {
    const children: string[] = [];
    for (const mediaUrl of preview.mediaUrls) {
      const child = await createContainer({ image_url: mediaUrl, is_carousel_item: "true" });
      children.push(child.id);
    }
    const parent = await createContainer({
      media_type: "CAROUSEL",
      children: children.join(","),
      caption: preview.caption,
    });
    const published = await publishContainer(parent.id);
    return { ok: true, mediaId: published.id, creationId: parent.id, type: preview.type };
  }

  if (preview.type === "reel") {
    const container = await createContainer({
      media_type: "REELS",
      video_url: preview.mediaUrls[0],
      caption: preview.caption,
      share_to_feed: "true",
    });
    await waitForContainer(container.id);
    const published = await publishContainer(container.id);
    return { ok: true, mediaId: published.id, creationId: container.id, type: preview.type };
  }

  if (preview.type === "story") {
    const isVideo = /\.(mp4|mov|m4v)(\?|$)/i.test(preview.mediaUrls[0]);
    const container = await createContainer({
      media_type: "STORIES",
      ...(isVideo ? { video_url: preview.mediaUrls[0] } : { image_url: preview.mediaUrls[0] }),
    });
    if (isVideo) await waitForContainer(container.id);
    const published = await publishContainer(container.id);
    return { ok: true, mediaId: published.id, creationId: container.id, type: preview.type };
  }

  const container = await createContainer({
    image_url: preview.mediaUrls[0],
    caption: preview.caption,
    ...(preview.altText ? { alt_text: preview.altText } : {}),
  });
  const published = await publishContainer(container.id);
  return { ok: true, mediaId: published.id, creationId: container.id, type: preview.type };
}
