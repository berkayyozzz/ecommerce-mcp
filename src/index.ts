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

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

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
  const code = "mcp-bypass-code-" + randomUUID();
  if (redirectUri) {
    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    console.log(`[OAuth] /authorize -> redirecting to callback`);
    res.redirect(url.toString());
  } else {
    res.json({ code });
  }
});

app.post("/token", (req, res) => {
  console.log("[OAuth] /token exchange");
  res.json({
    access_token: "mcp-no-auth-token",
    token_type: "bearer",
    expires_in: 86400,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP Tool definitions (shared factory so each transport gets its own Server)
// ─────────────────────────────────────────────────────────────────────────────

function createMcpServer() {
  const server = new Server(
    { name: "ecommerce-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_etsy_products",
        description:
          "Etsy uzerinde kelimeye gore arama yapar, urunlerin fiyatlarini, resimlerini ve linklerini getirir.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Etsy'de aranacak anahtar kelime",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "search_alibaba_products",
        description:
          "Alibaba uzerinde toptan urun arar, fiyat araliklarini, MOQ bilgilerini, resim ve linkleri getirir.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Alibaba'da aranacak anahtar kelime",
            },
          },
          required: ["query"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // If API keys are not yet configured, return the placeholder message
    if (!process.env.ETSY_API_KEY || !process.env.ALIBABA_API_KEY) {
      return {
        content: [
          {
            type: "text",
            text: "Merhaba ben berkay henüz etsy ve alibaba da developer hesabı açıp apileri bağlamadım veriler çok yakında",
          },
        ],
      };
    }

    try {
      if (name === "search_etsy_products") {
        const query = args?.query as string;
        if (!query) throw new Error("Arama kelimesi gerekli.");
        const results = await scrapeEtsyProducts(query);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }

      if (name === "search_alibaba_products") {
        const query = args?.query as string;
        if (!query) throw new Error("Arama kelimesi gerekli.");
        const results = await scrapeAlibabaProducts(query);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }

      throw new Error(`Bilinmeyen arac: ${name}`);
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Hata: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
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

// Mount MCP handler on both /mcp and / (Claude Web may use either)
app.all(["/", "/mcp"], (req, res) => {
  // Skip OAuth endpoints that are already handled above
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
