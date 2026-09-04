import express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { escapeHtml, verifyConnectorPassword } from "./oauth.js";

const scopes = ["boards:read", "pins:read", "pins:write", "user_accounts:read"];
const sessions = new Map<string, { expires: number; phase: "login" | "oauth"; attempts: number }>();
const cookieName = "__Host-pinterest-setup";

function settings() {
  const id = process.env.PINTEREST_CLIENT_ID;
  const secret = process.env.PINTEREST_CLIENT_SECRET;
  const redirect = process.env.PINTEREST_REDIRECT_URI;
  if (!id || !secret || !redirect) throw new Error("Pinterest OAuth ayarlari eksik.");
  const u = new URL(redirect);
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/pinterest/callback") throw new Error("HTTPS /pinterest/callback redirect gerekli.");
  return { id, secret, redirect, origin: u.origin };
}

function cookie(req: express.Request) {
  return (req.headers.cookie || "").split(";").map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) || "";
}
function equal(a: string, b: string) {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length > 0 && aa.length === bb.length && timingSafeEqual(aa, bb);
}
function page(res: express.Response, content: string, status = 200) {
  return res.status(status).type("html").send(`<!doctype html><html lang="tr"><meta charset="utf-8"><title>Pinterest bağlantısı</title><body><main><h1>Pinterest bağlantısı</h1>${content}</main></body></html>`);
}

export const pinterestOAuthRouter = express.Router();
pinterestOAuthRouter.use((_req, res, next) => {
  res.set({ "Cache-Control": "no-store", "Pragma": "no-cache", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
  next();
});
pinterestOAuthRouter.get("/connect", (_req, res) => {
  try {
    settings();
    // Native form POSTs use Origin: null under no-referrer. Keep the
    // callback private, but allow the login form's strict Origin check.
    res.set("Referrer-Policy", "same-origin");
    res.set("Content-Security-Policy", "default-src 'none'; form-action 'self' https://www.pinterest.com; frame-ancestors 'none'; base-uri 'none'");
    for (const [k, s] of sessions) if (s.expires < Date.now()) sessions.delete(k);
    if (sessions.size >= 100) return page(res, "Kurulum yogun. Biraz sonra tekrar deneyin.", 429);
    const nonce = randomBytes(32).toString("hex");
    sessions.set(nonce, { expires: Date.now() + 10 * 60_000, phase: "login", attempts: 0 });
    res.cookie(cookieName, nonce, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 10 * 60_000 });
    return page(res, `<p>Mevcut MCP baglanma sifrenizi girin. Pinterest hesap/pano okuma ve Pin yayinlama izni istenir. Bu islem Pin yayinlamaz.</p><form method="post" action="/pinterest/connect"><input type="hidden" name="nonce" value="${nonce}"><label>MCP sifresi <input type="password" name="password" autocomplete="current-password" required></label><button type="submit">Pinterest hesabini yetkilendir</button></form>`);
  } catch { return page(res, "Render Pinterest OAuth ayarlari eksik veya gecersiz.", 503); }
});
pinterestOAuthRouter.post("/connect", (req, res) => {
  try {
    const c = settings();
    const nonce = String(req.body?.nonce || "");
    const session = sessions.get(nonce);
    if (req.headers.origin !== c.origin || !equal(cookie(req), nonce) || !session || session.expires < Date.now() || session.phase !== "login") return page(res, "Oturum gecersiz. /pinterest/connect adresinden yeniden baslayin.", 403);
    session.attempts++;
    if (session.attempts > 5) { sessions.delete(nonce); return page(res, "Cok fazla deneme.", 429); }
    if (!verifyConnectorPassword(String(req.body?.password || ""))) return page(res, "MCP sifresi yanlis. Geri donerek tekrar deneyin.", 401);
    session.phase = "oauth";
    const url = new URL("https://www.pinterest.com/oauth/");
    url.search = new URLSearchParams({ client_id: c.id, redirect_uri: c.redirect, response_type: "code", scope: scopes.join(","), state: nonce }).toString();
    return res.redirect(303, url.toString());
  } catch { return page(res, "Yetkilendirme baslatilamadi. Sunucu ayarlarini kontrol edin.", 503); }
});
pinterestOAuthRouter.get("/callback", async (req, res) => {
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const session = sessions.get(state);
  if (!equal(cookie(req), state) || !session || session.phase !== "oauth" || session.expires < Date.now()) return page(res, "Gecersiz veya suresi dolmus OAuth oturumu. Yeniden baglanin.", 403);
  sessions.delete(state); // Single use even on denial/error.
  res.clearCookie(cookieName, { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
  if (req.query.error) return page(res, "Pinterest izni verilmedi. Hicbir token etkinlestirilmedi.", 400);
  if (typeof req.query.code !== "string" || !req.query.code) return page(res, "Yetkilendirme kodu eksik.", 400);
  try {
    const c = settings();
    const base = process.env.PINTEREST_SANDBOX === "true" ? "https://api-sandbox.pinterest.com/v5" : "https://api.pinterest.com/v5";
    const response = await fetch(`${base}/oauth/token`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Basic ${Buffer.from(`${c.id}:${c.secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: req.query.code, redirect_uri: c.redirect }),
    });
    if (!response.ok) return page(res, `Pinterest token istegi basarisiz (HTTP ${response.status}). Yeniden baglanin.`, 400);
    const data = await response.json() as { access_token?: string; refresh_token?: string; scope?: string; expires_in?: number };
    const granted = new Set(String(data.scope || "").split(/[ ,]+/));
    if (!data.access_token || !scopes.every(s => granted.has(s))) return page(res, "Gerekli Pinterest izinleri verilmedi. Uygulama erisimini ve pins:write iznini kontrol edin.", 403);
    return page(res, `<h2>Yetki alindi; Render'a kaydetme gerekli</h2><p>Bu sayfa gizli bilgiler icerir. Ekran goruntusu veya sohbetle paylasmayin. Token sunucu belleğinde kalici tutulmaz ve otomatik etkinlestirilmez.</p><p>Render Environment icinde PINTEREST_ACCESS_TOKEN degerine asagidakini kaydedin:</p><textarea readonly rows="5" cols="80">${escapeHtml(data.access_token)}</textarea><p>Gerekirse daha sonra token yenilemek icin refresh tokenini guvenli sifre kasanizda saklayin (otomatik yenileme bu surumde yok):</p><textarea readonly rows="5" cols="80">${escapeHtml(data.refresh_token || "Verilmedi")}</textarea><p>Izinler: ${escapeHtml(data.scope || "")}.</p><p>Access token omru (saniye): ${escapeHtml(String(data.expires_in ?? "Bilinmiyor"))}. Render kaydindan sonra Claude'da hesap ve panolari kontrol edin. Pin yayinlanmadi.</p>`);
  } catch { return page(res, "Pinterest token alimi tamamlanamadi. Yeni bir baglanti baslatin. Gizli hata ayrintilari gosterilmez.", 502); }
});
