import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { scrapeEtsyProducts } from "./services/etsy.js";
import { scrapeAlibabaProducts } from "./services/alibaba.js";
import { randomUUID } from "node:crypto";
import {
  createAuthorizationCode,
  escapeHtml,
  exchangeAuthorizationCode,
  isAllowedRedirectUri,
  verifyAccessToken,
  verifyConnectorPassword,
} from "./oauth.js";
import {
  getInstagramAccount,
  previewInstagramPost,
  publishInstagramPost,
  type InstagramPostInput,
} from "./services/instagram.js";
import {
  completeInstagramMediaUpload,
  createInstagramDirectUpload,
  receiveInstagramDirectUpload,
  uploadInstagramMedia,
  uploadInstagramMediaChunk,
  type CompleteMediaUploadInput,
  type MediaChunkInput,
  type MediaUploadInput,
} from "./services/media-upload.js";

dotenv.config();

const app = express();
const instagramMaxMediaMb = Math.max(1, Number(process.env.INSTAGRAM_MAX_MEDIA_MB || 100));
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "20mb" }));
app.use(express.static("public"));

app.put(
  "/media-upload/:token",
  express.raw({ type: () => true, limit: `${instagramMaxMediaMb}mb` }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) throw new Error("Ham medya verisi gerekli.");
      const result = await receiveInstagramDirectUpload(
        String(req.params.token || ""),
        req.body,
        String(req.headers["content-type"] || ""),
      );
      res.json(result);
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "Medya yuklenemedi.",
      });
    }
  },
);

// Log all incoming requests (shorten headers for readability)
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// OAuth Discovery Endpoints (required by Claude Web MCP connector)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  console.log("[OAuth] Serving oauth-protected-resource metadata");
  res.json({
    resource: baseUrl,
    authorization_servers: [`${baseUrl}`],
    bearer_methods_supported: ["header"],
    logo_uri: `${baseUrl}/logo.jpg`,
  });
});

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  console.log("[OAuth] Serving oauth-authorization-server metadata");
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    logo_uri: `${baseUrl}/logo.jpg`,
    service_name: "Baby Shower Chocolate",
  });
});

app.post("/register", (req, res) => {
  console.log("[OAuth] Dynamic client registration");
  res.status(201).json({
    client_id: `mcp-client-${Date.now()}`,
    client_secret_expires_at: 0,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: req.body?.redirect_uris || [],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

app.get("/authorize", (req, res) => {
  const redirectUri = req.query.redirect_uri as string;
  const state = req.query.state as string;
  const codeChallenge = req.query.code_challenge as string;
  if (!redirectUri || !isAllowedRedirectUri(redirectUri) || !codeChallenge) {
    res.status(400).send("Gecersiz OAuth istegi.");
    return;
  }

  const fields = { redirectUri, state: state || "", codeChallenge };
  res.type("html").send(`<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Ecommerce MCP Baglantisi</title>
<style>body{font-family:system-ui;background:#111827;color:#f9fafb;display:grid;place-items:center;min-height:100vh;margin:0}.card{width:min(420px,90vw);background:#1f2937;padding:28px;border-radius:16px}input,button{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;margin-top:12px}button{background:#7c3aed;color:white;border:0;font-weight:700}</style></head>
<body><form class="card" method="post" action="/authorize"><h1>Ecommerce MCP</h1><p>Claude baglantisini yetkilendirmek icin Render'da tanimladiginiz baglanti parolasini girin.</p>
<input type="hidden" name="redirect_uri" value="${escapeHtml(fields.redirectUri)}">
<input type="hidden" name="state" value="${escapeHtml(fields.state)}">
<input type="hidden" name="code_challenge" value="${escapeHtml(fields.codeChallenge)}">
<input type="password" name="password" autocomplete="current-password" required placeholder="Baglanti parolasi">
<button type="submit">Claude'a baglan</button></form></body></html>`);
});

app.post("/authorize", (req, res) => {
  try {
    const redirectUri = String(req.body.redirect_uri || "");
    const state = String(req.body.state || "");
    const codeChallenge = String(req.body.code_challenge || "");
    if (!isAllowedRedirectUri(redirectUri) || !codeChallenge) throw new Error("Gecersiz OAuth istegi.");
    if (!verifyConnectorPassword(String(req.body.password || ""))) {
      res.status(401).send("Baglanti parolasi yanlis.");
      return;
    }
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", createAuthorizationCode(redirectUri, codeChallenge));
    if (state) callback.searchParams.set("state", state);
    res.redirect(callback.toString());
  } catch (error) {
    res.status(400).send(error instanceof Error ? error.message : "Yetkilendirme basarisiz.");
  }
});

app.post("/token", (req, res) => {
  try {
    const accessToken = exchangeAuthorizationCode({
      code: String(req.body.code || ""),
      redirectUri: String(req.body.redirect_uri || ""),
      codeVerifier: String(req.body.code_verifier || ""),
    });
    res.json({ access_token: accessToken, token_type: "bearer", expires_in: 30 * 24 * 60 * 60 });
  } catch (error) {
    res.status(400).json({
      error: "invalid_grant",
      error_description: error instanceof Error ? error.message : "Token alinamadi.",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP Tool definitions (shared factory so each transport gets its own Server)
// ─────────────────────────────────────────────────────────────────────────────

function createMcpServer() {
  const server = new Server(
    { name: "ecommerce-mcp-server", version: "1.2.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_etsy_products",
        description: "Etsy uzerinde urun arar.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", description: "Arama kelimesi" } },
          required: ["query"],
        },
      },
      {
        name: "search_alibaba_products",
        description: "Alibaba uzerinde toptan urun arar.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", description: "Arama kelimesi" } },
          required: ["query"],
        },
      },
      {
        name: "instagram_get_account",
        description: "Bagli Instagram Business/Creator hesabini dogrular. Yayin yapmaz.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "instagram_upload_media",
        description:
          "Instagram icin gorsel veya videoyu Vercel Blob'a yukler ve public HTTPS URL dondurur. Yayin yapmaz. Claude ekindeki medya erisilebilir URL olarak sunulmuyorsa dataUrl/base64Data kullanilabilir.",
        inputSchema: {
          type: "object",
          properties: {
            sourceUrl: { type: "string", format: "uri", description: "Indirilebilir HTTPS medya URL'si" },
            dataUrl: { type: "string", description: "data:image/...;base64,... biciminde medya" },
            base64Data: { type: "string", description: "Ham base64 medya verisi" },
            mimeType: {
              type: "string",
              enum: ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"],
              description: "base64Data kullanildiginda zorunlu",
            },
            fileName: { type: "string", description: "Dosya adi ipucu" },
          },
        },
      },
      {
        name: "instagram_create_direct_upload",
        description:
          "Claude'un kendi urettigi veya kod calistirma konteynerinde bulunan gorsel/video icin 10 dakika gecerli guvenli binary yukleme URL'si olusturur. Claude dosyayi base64'e cevirmeden kendi kod ortamindan HTTP PUT ile uploadUrl adresine gonderir. Yayin yapmaz.",
        inputSchema: {
          type: "object",
          properties: {
            mimeType: {
              type: "string",
              enum: ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"],
            },
            fileName: { type: "string", description: "Claude konteynerindeki dosyanin adi" },
          },
          required: ["mimeType"],
        },
      },
      {
        name: "instagram_upload_media_chunk",
        description:
          "Claude sohbetine eklenen buyuk bir medya dosyasini Shopify'a veya kullaniciya yukletmeden, kucuk base64 parcalari halinde Vercel Blob'a yukler. Base64 verisini sirali ve en fazla 750000 karakterlik parcalara bol; her parca icin ayni uploadId kullan. Yayin yapmaz.",
        inputSchema: {
          type: "object",
          properties: {
            uploadId: { type: "string", description: "Bu yuklemeye ozel, en az 6 karakterlik kimlik" },
            chunkIndex: { type: "integer", minimum: 0, description: "0'dan baslayan parca sirasi" },
            totalChunks: { type: "integer", minimum: 1, maximum: 40 },
            base64Chunk: { type: "string", description: "En fazla 750000 karakterlik base64 parcasi" },
          },
          required: ["uploadId", "chunkIndex", "totalChunks", "base64Chunk"],
        },
      },
      {
        name: "instagram_complete_media_upload",
        description:
          "instagram_upload_media_chunk aracinin dondurdugu chunkUrl degerlerini chunkIndex sirasiyla birlestirir, asil medyayi public HTTPS URL olarak Vercel Blob'a yukler ve gecici parcalari siler. Yayin yapmaz.",
        inputSchema: {
          type: "object",
          properties: {
            uploadId: { type: "string" },
            chunkUrls: {
              type: "array",
              minItems: 1,
              maxItems: 40,
              items: { type: "string", format: "uri" },
              description: "Parca aracinin cevaplari, chunkIndex sirasinda",
            },
            mimeType: {
              type: "string",
              enum: ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"],
            },
            fileName: { type: "string" },
          },
          required: ["uploadId", "chunkUrls", "mimeType"],
        },
      },
      {
        name: "instagram_preview_post",
        description:
          "Instagram gonderisini yayinlamadan once dogrular ve onizleme hash'i uretir. Yayin yapmaz.",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["image", "carousel", "reel", "story"] },
            caption: { type: "string", description: "Nihai Ingilizce caption" },
            mediaUrls: {
              type: "array",
              items: { type: "string", format: "uri" },
              description: "Public HTTPS gorsel veya video URL'leri",
            },
            altText: { type: "string", description: "Tek gorsel icin Ingilizce alt text" },
          },
          required: ["type", "caption", "mediaUrls"],
        },
      },
      {
        name: "instagram_publish_post",
        description:
          "ONEMLI YAZMA ISLEMI: Yalniz kullanici onizlemeyi gordukten sonra tam olarak 'SON ONAY: YAYINLA' yazarsa Instagram'a yayin yapar.",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["image", "carousel", "reel", "story"] },
            caption: { type: "string" },
            mediaUrls: { type: "array", items: { type: "string", format: "uri" } },
            altText: { type: "string" },
            previewHash: { type: "string", description: "Onizleme aracinin dondurdugu hash" },
            approval: { type: "string", description: "Kullanicinin birebir son onay ifadesi" },
          },
          required: ["type", "caption", "mediaUrls", "previewHash", "approval"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === "search_etsy_products") {
        if (!process.env.ETSY_API_KEY) throw new Error("ETSY_API_KEY yapilandirilmadi.");
        const query = args?.query as string;
        if (!query) throw new Error("Arama kelimesi gerekli.");
        const results = await scrapeEtsyProducts(query);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }

      if (name === "search_alibaba_products") {
        if (!process.env.ALIBABA_API_KEY) throw new Error("ALIBABA_API_KEY yapilandirilmadi.");
        const query = args?.query as string;
        if (!query) throw new Error("Arama kelimesi gerekli.");
        const results = await scrapeAlibabaProducts(query);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }

      if (name === "instagram_get_account") {
        const result = await getInstagramAccount();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (name === "instagram_upload_media") {
        const result = await uploadInstagramMedia(args as unknown as MediaUploadInput);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (name === "instagram_create_direct_upload") {
        const baseUrl = String(process.env.PUBLIC_BASE_URL || "https://ecommerce-mcp-jlt3.onrender.com").replace(/\/$/, "");
        const result = createInstagramDirectUpload(
          args as unknown as { mimeType: string; fileName?: string },
          baseUrl,
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (name === "instagram_upload_media_chunk") {
        const result = await uploadInstagramMediaChunk(args as unknown as MediaChunkInput);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (name === "instagram_complete_media_upload") {
        const result = await completeInstagramMediaUpload(args as unknown as CompleteMediaUploadInput);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (name === "instagram_preview_post") {
        const result = previewInstagramPost(args as unknown as InstagramPostInput);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (name === "instagram_publish_post") {
        const result = await publishInstagramPost(
          args as unknown as InstagramPostInput & { previewHash: string; approval: string },
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      throw new Error(`Bilinmeyen arac: ${name}`);
    } catch (error) {
      return {
        content: [{ type: "text", text: `Hata: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ─────────────────────────────────────────────────────────────────────────────
// Streamable HTTP MCP endpoint  (handles GET, POST, DELETE on /mcp and /)
// Claude Web uses the NEW Streamable HTTP transport (not the deprecated SSE one)
// ─────────────────────────────────────────────────────────────────────────────

// Session store for stateful mode
const sessions = new Map<
  string,
  { transport: StreamableHTTPServerTransport; server: Server }
>();

async function handleMcpRequest(
  req: express.Request,
  res: express.Response
) {
  console.log(`[MCP] ${req.method} ${req.url}`);

  // Stateful: re-use existing session if Mcp-Session-Id header is present
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let session = sessionId ? sessions.get(sessionId) : undefined;

  if (!session) {
    // New session – create a fresh transport + server pair
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const server = createMcpServer();
    await server.connect(transport);

    session = { transport, server };

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        console.log(`[MCP] Session closed: ${transport.sessionId}`);
      }
    };

    // Store only after we know the session ID (set during first handleRequest)
    // We attach it after handleRequest returns if a session ID was generated.
  }

  await session.transport.handleRequest(req, res, req.body);

  // After the first request, the transport will have assigned a session ID.
  // Register it in our map so subsequent requests can find this session.
  const assignedId = session.transport.sessionId;
  if (assignedId && !sessions.has(assignedId)) {
    sessions.set(assignedId, session);
    console.log(`[MCP] Session registered: ${assignedId}`);
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "ecommerce-mcp",
    version: "1.2.0",
    configured: {
      connectorAuth: Boolean(process.env.MCP_CONNECTOR_SECRET),
      instagram: Boolean(
        (process.env.META_IG_USER_ID || process.env.INSTAGRAM_ACCOUNT_ID) &&
          (process.env.META_ACCESS_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN),
      ),
      mediaUpload: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    },
  });
});

// Mount MCP handler on both /mcp and / (Claude Web may use either)
app.all(["/", "/mcp"], (req, res) => {
  try {
    const authorization = req.headers.authorization || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token || !verifyAccessToken(token)) {
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
      );
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  } catch {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
    );
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  handleMcpRequest(req, res).catch((err) => {
    console.error("[MCP] Unhandled error:", err);
    if (!res.headersSent) res.status(500).send("Internal server error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
  console.log(`==========================================`);
  console.log(`MCP Server running on port ${PORT}`);
  console.log(`==========================================`);
});
