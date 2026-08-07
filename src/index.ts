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

dotenv.config();

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static("public"));

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
    { name: "ecommerce-mcp-server", version: "1.1.0" },
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
    version: "1.1.0",
    configured: {
      connectorAuth: Boolean(process.env.MCP_CONNECTOR_SECRET),
      instagram: Boolean(
        (process.env.META_IG_USER_ID || process.env.INSTAGRAM_ACCOUNT_ID) &&
          (process.env.META_ACCESS_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN),
      ),
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
