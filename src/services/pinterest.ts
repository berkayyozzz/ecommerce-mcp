import { createHash } from "node:crypto";

const APPROVAL = "SON ONAY: YAYINLA";
export type PinInput = { boardId: string; title: string; description?: string; imageUrl: string; link?: string; altText?: string };

function config() {
  const token = process.env.PINTEREST_ACCESS_TOKEN;
  if (!token) throw new Error("Render PINTEREST_ACCESS_TOKEN gerekli (pins:write yetkili OAuth token).");
  return { token, base: process.env.PINTEREST_SANDBOX === "true" ? "https://api-sandbox.pinterest.com/v5" : "https://api.pinterest.com/v5" };
}

function httpsUrl(value: string) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".") ||
      /^[\d.]+$/.test(u.hostname) || u.hostname.includes(":") || /(^|\.)(localhost|local|internal)$/.test(u.hostname)) {
    throw new Error("Kimlik bilgisi icermeyen public HTTPS URL gerekli.");
  }
  return u.toString();
}

export function normalizePin(input: PinInput): PinInput {
  if (!input || !/^\d+$/.test(input.boardId || "")) throw new Error("Gecerli boardId gerekli.");
  const title = String(input.title || "").trim();
  const description = String(input.description || "").trim();
  const altText = String(input.altText || "").trim();
  if (!title || title.length > 100 || description.length > 800 || altText.length > 500) {
    throw new Error("Baslik 1-100, aciklama en fazla 800, alt metin en fazla 500 karakter olmali.");
  }
  const link = input.link ? httpsUrl(input.link) : undefined;
  if (link && link.length > 2048) throw new Error("Link en fazla 2048 karakter olmali.");
  return { boardId: input.boardId, title, description, imageUrl: httpsUrl(input.imageUrl), link, altText };
}

async function api(path: string, body?: unknown): Promise<Record<string, any>> {
  const { token, base } = config();
  let response: Response;
  try {
    response = await fetch(`${base}/${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
  } catch {
    throw new Error(body ? "Pinterest yayin sonucu BELIRSIZ. Otomatik tekrar yayinlama; once Pinterest hesabini kontrol et." : "Pinterest baglantisi basarisiz.");
  }
  if (!response.ok) throw new Error(`Pinterest HTTP ${response.status}. ${response.status === 401 || response.status === 403 ? "Token, API erisimi ve OAuth kapsamlarini kontrol edin." : body ? "Sonucu hesapta kontrol etmeden tekrar yayinlamayin." : "Istek basarisiz."}`);
  try { return await response.json() as Record<string, any>; }
  catch { throw new Error("Pinterest yaniti okunamadi; yayin istegiyse sonucu hesapta dogrulayin, tekrar gondermeyin."); }
}

export async function getPinterestAccount() {
  const account = await api("user_account");
  return { username: account.username, accountType: account.account_type, sandbox: process.env.PINTEREST_SANDBOX === "true" };
}

export async function listPinterestBoards(bookmark?: string) {
  return api(`boards?page_size=100${bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : ""}`);
}

export async function previewPinterestPin(input: PinInput) {
  const pin = normalizePin(input);
  const account = await getPinterestAccount();
  if (!account.username) throw new Error("Pinterest hesap kimligi dogrulanamadi.");
  const board = await api(`boards/${pin.boardId}`);
  if (board.id !== pin.boardId) throw new Error("Pano dogrulanamadi.");
  const target = { account, board: { id: board.id, name: board.name, privacy: board.privacy }, pin };
  return { ...target, previewHash: createHash("sha256").update(JSON.stringify(target)).digest("hex"), approvalRequired: APPROVAL,
    warning: "Gorseli, hesabi, panoyu ve urun linkini kullaniciya goster. Medya URL erisimi Pinterest yayin isteginde dogrulanir. Bu islem yayin yapmaz." };
}

export async function publishPinterestPin(input: PinInput & { approval: string; previewHash: string }) {
  if (input.approval !== APPROVAL) throw new Error(`Acik kullanici onayi gerekli: ${APPROVAL}`);
  const preview = await previewPinterestPin(input);
  if (preview.previewHash !== input.previewHash) throw new Error("Icerik veya hedef degisti. Yeni onizleme ve onay gerekli.");
  const p = preview.pin;
  const result = await api("pins", { board_id: p.boardId, title: p.title, description: p.description,
    alt_text: p.altText, ...(p.link ? { link: p.link } : {}), media_source: { source_type: "image_url", url: p.imageUrl } });
  if (typeof result.id !== "string" || !/^\d+$/.test(result.id)) throw new Error("Pin ID dogrulanamadi. Sonuc belirsiz; tekrar yayinlamadan hesabi kontrol edin.");
  return { ok: true, pinId: result.id, url: `https://www.pinterest.com/pin/${result.id}/`, account: preview.account,
    board: preview.board, sandbox: preview.account.sandbox, warning: "Ayni onayi tekrar gondermek yeni Pin olusturabilir; otomatik tekrar yapmayin." };
}

const fields = {
  boardId: { type: "string", description: "pinterest_list_boards sonucundan pano ID" },
  title: { type: "string", maxLength: 100 }, description: { type: "string", maxLength: 800 },
  imageUrl: { type: "string", description: "Public HTTPS JPEG/PNG. Mevcut direct upload publicUrl kullanilabilir." },
  link: { type: "string", description: "Opsiyonel urun sayfasinin HTTPS adresi" }, altText: { type: "string", maxLength: 500 },
};
export const pinterestTools = [
  { name: "pinterest_get_account", description: "Pinterest hesabini dogrula; yayin yapmaz.", inputSchema: { type: "object", properties: {} } },
  { name: "pinterest_list_boards", description: "Pinterest panolarini listele. Sonucta bookmark varsa sonraki sayfayi iste. Yayin yapmaz.", inputSchema: { type: "object", properties: { bookmark: { type: "string" } } } },
  { name: "pinterest_preview_pin", description: "Tek gorselli Pin onizlemesi: hesap, pano, baslik, gorsel, link. Kullaniciya goster; yayin yapmaz.", inputSchema: { type: "object", properties: fields, required: ["boardId", "title", "imageUrl"] } },
  { name: "pinterest_publish_pin", description: "YALNIZCA kullanici onizlemeyi SON ONAY: YAYINLA ile onayladiginda Pin olustur. Belirsiz sonuc veya zaman asiminda otomatik tekrar yapma. Zamanlama/video desteklenmez.", inputSchema: { type: "object", properties: { ...fields, approval: { type: "string" }, previewHash: { type: "string" } }, required: ["boardId", "title", "imageUrl", "approval", "previewHash"] } },
];
