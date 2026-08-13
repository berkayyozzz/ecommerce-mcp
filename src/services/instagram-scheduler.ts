import { randomUUID, timingSafeEqual } from "node:crypto";
import { list, put } from "@vercel/blob";
import {
  previewInstagramPost,
  publishInstagramPost,
  type InstagramPostInput,
} from "./instagram.js";

const SCHEDULE_APPROVAL = "SON ONAY: ZAMANLA";
const RECORD_PREFIX = "instagram-schedules/";

export type InstagramScheduleRecord = {
  id: string;
  messageId: string;
  status: "scheduled" | "cancelled" | "publishing" | "published" | "failed";
  scheduledAt: string;
  scheduledAtUtc: string;
  timezone: string;
  post: InstagramPostInput;
  previewHash: string;
  createdAt: string;
  updatedAt: string;
  mediaId?: string;
  error?: string;
};

type ScheduledPayload = {
  scheduleId: string;
  post: InstagramPostInput;
  previewHash: string;
};

function qstashConfig() {
  const token = process.env.QSTASH_TOKEN;
  const baseUrl = (process.env.QSTASH_URL || "https://qstash.upstash.io").replace(/\/$/, "");
  const publicBaseUrl = (
    process.env.PUBLIC_BASE_URL || "https://ecommerce-mcp-jlt3.onrender.com"
  ).replace(/\/$/, "");
  const schedulerSecret = process.env.INSTAGRAM_SCHEDULER_SECRET || process.env.MCP_CONNECTOR_SECRET;
  if (!token) throw new Error("QSTASH_TOKEN Render environment alaninda tanimlanmali.");
  if (!schedulerSecret || schedulerSecret.length < 24) {
    throw new Error("INSTAGRAM_SCHEDULER_SECRET veya MCP_CONNECTOR_SECRET en az 24 karakter olmali.");
  }
  return { token, baseUrl, publicBaseUrl, schedulerSecret };
}

function validateScheduledAt(raw: string) {
  const value = String(raw || "").trim();
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error("scheduledAt saat dilimi iceren ISO 8601 olmali. Ornek: 2026-08-13T20:00:00+03:00");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("scheduledAt gecersiz.");
  const now = Date.now();
  if (date.getTime() < now + 60_000) throw new Error("Paylasim zamani en az 1 dakika ileride olmali.");
  const maxDays = Math.max(1, Number(process.env.QSTASH_MAX_SCHEDULE_DAYS || 7));
  if (date.getTime() > now + maxDays * 24 * 60 * 60 * 1000) {
    throw new Error(`Bu kurulumda en fazla ${maxDays} gun ileri zamanlanabilir.`);
  }
  return date;
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifySchedulerSecret(value: string) {
  const { schedulerSecret } = qstashConfig();
  return safeEqual(value, schedulerSecret);
}

async function saveRecord(record: InstagramScheduleRecord) {
  await put(`${RECORD_PREFIX}${record.id}.json`, JSON.stringify(record), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return record;
}

async function allRecords() {
  const result = await list({ prefix: RECORD_PREFIX, limit: 1000 });
  const records = await Promise.all(
    result.blobs.map(async (blob) => {
      try {
        const response = await fetch(blob.url, { cache: "no-store" });
        if (!response.ok) return null;
        return (await response.json()) as InstagramScheduleRecord;
      } catch {
        return null;
      }
    }),
  );
  return records.filter((record): record is InstagramScheduleRecord => Boolean(record));
}

async function getRecord(id: string) {
  const records = await allRecords();
  return records.find((record) => record.id === id) || null;
}

export async function scheduleInstagramPost(input: InstagramPostInput & {
  previewHash: string;
  approval: string;
  scheduledAt: string;
  timezone?: string;
}) {
  if (input.approval !== SCHEDULE_APPROVAL) {
    throw new Error(`Zamanlama icin kullanici tam olarak \"${SCHEDULE_APPROVAL}\" yazmalidir.`);
  }
  const preview = previewInstagramPost(input);
  if (preview.previewHash !== input.previewHash) {
    throw new Error("Icerik onizlemeden sonra degismis. Yeniden onizleme ve onay gerekli.");
  }

  const scheduledDate = validateScheduledAt(input.scheduledAt);
  const { token, baseUrl, publicBaseUrl, schedulerSecret } = qstashConfig();
  const id = randomUUID();
  const payload: ScheduledPayload = {
    scheduleId: id,
    post: {
      type: preview.type,
      caption: preview.caption,
      mediaUrls: preview.mediaUrls,
      altText: preview.altText,
    },
    previewHash: preview.previewHash,
  };
  const destination = `${publicBaseUrl}/api/instagram/scheduled-publish`;
  const response = await fetch(`${baseUrl}/v2/publish/${destination}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Upstash-Not-Before": String(Math.floor(scheduledDate.getTime() / 1000)),
      "Upstash-Retries": "3",
      "Upstash-Timeout": "600s",
      "Upstash-Label": `instagram,${id}`,
      "Upstash-Deduplication-Id": `instagram-${id}`,
      "Upstash-Forward-X-Instagram-Schedule-Secret": schedulerSecret,
    },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => ({}))) as { messageId?: string; error?: string };
  if (!response.ok || !body.messageId) {
    throw new Error(body.error || `QStash HTTP ${response.status}`);
  }

  const now = new Date().toISOString();
  const record: InstagramScheduleRecord = {
    id,
    messageId: body.messageId,
    status: "scheduled",
    scheduledAt: input.scheduledAt,
    scheduledAtUtc: scheduledDate.toISOString(),
    timezone: input.timezone || "Europe/Istanbul",
    post: payload.post,
    previewHash: payload.previewHash,
    createdAt: now,
    updatedAt: now,
  };
  await saveRecord(record);
  return {
    ok: true,
    schedule: record,
    note: "Claude kapali olsa bile QStash belirtilen zamanda yayini tetikleyecek.",
  };
}

export async function listInstagramSchedules() {
  const records = await allRecords();
  return records.sort((a, b) => new Date(b.scheduledAtUtc).getTime() - new Date(a.scheduledAtUtc).getTime());
}

export async function cancelInstagramSchedule(id: string) {
  const record = await getRecord(id);
  if (!record) throw new Error("Zamanlanmis paylasim bulunamadi.");
  if (record.status !== "scheduled") throw new Error(`Bu kayit iptal edilemez. Durum: ${record.status}`);
  const { token, baseUrl } = qstashConfig();
  const response = await fetch(`${baseUrl}/v2/messages/${encodeURIComponent(record.messageId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok && response.status !== 404) throw new Error(`QStash iptal HTTP ${response.status}`);
  record.status = "cancelled";
  record.updatedAt = new Date().toISOString();
  await saveRecord(record);
  return { ok: true, schedule: record };
}

export async function executeScheduledInstagramPost(payload: ScheduledPayload) {
  const record = await getRecord(payload.scheduleId);
  if (!record) throw new Error("Zamanlama kaydi bulunamadi.");
  if (record.status === "cancelled") return { ok: true, skipped: true, reason: "cancelled" };
  if (record.status === "published") return { ok: true, duplicate: true, mediaId: record.mediaId };

  record.status = "publishing";
  record.updatedAt = new Date().toISOString();
  await saveRecord(record);
  try {
    const result = await publishInstagramPost({
      ...payload.post,
      previewHash: payload.previewHash,
      approval: "SON ONAY: YAYINLA",
    });
    record.status = "published";
    record.mediaId = result.mediaId;
    record.updatedAt = new Date().toISOString();
    record.error = undefined;
    await saveRecord(record);
    return result;
  } catch (error) {
    record.status = "failed";
    record.error = error instanceof Error ? error.message : String(error);
    record.updatedAt = new Date().toISOString();
    await saveRecord(record);
    throw error;
  }
}

