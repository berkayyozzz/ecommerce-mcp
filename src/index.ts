import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { scrapeEtsyProducts } from "./services/etsy.js";
import { scrapeAlibabaProducts } from "./services/alibaba.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Log all incoming requests
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url} - Headers: ${JSON.stringify(req.headers)}`);
  next();
});

// Store active transports by sessionId
const transports = new Map<string, SSEServerTransport>();

// Map both root (/) and /sse to SSE transport handler
app.get(["/", "/sse"], async (req, res) => {
  res.setHeader("X-Accel-Buffering", "no");

  if (req.method === "HEAD") {
    console.log(`[HEAD] Responding 200 OK to connection check.`);
    res.status(200).end();
    return;
  }

  console.log(`[SSE] New connection attempt.`);

  // Create a connection-specific Server instance to avoid "Already connected to a transport" errors
  const connectionServer = new Server(
    {
      name: "ecommerce-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Define tools list for this instance
  connectionServer.setRequestHandler(
    ListToolsRequestSchema,
    async () => {
      return {
        tools: [
          {
            name: "search_etsy_products",
            description: "Etsy uzerinde kelimeye gore arama yapar, urunlerin fiyatlarini, resimlerini ve linklerini getirir.",
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
            description: "Alibaba uzerinde toptan urun arar, fiyat araliklarini, MOQ (minimum siparis miktari) bilgilerini, resim ve linkleri getirir.",
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
      };
    }
  );

  // Handle tool executions for this instance
  connectionServer.setRequestHandler(
    CallToolRequestSchema,
    async (request) => {
      const { name, arguments: args } = request.params;
      
      try {
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

        if (name === "search_etsy_products") {
          const query = args?.query as string;
          if (!query) throw new Error("Arama kelimesi gerekli.");
          const results = await scrapeEtsyProducts(query);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(results, null, 2),
              },
            ],
          };
        }
        
        if (name === "search_alibaba_products") {
          const query = args?.query as string;
          if (!query) throw new Error("Arama kelimesi gerekli.");
          const results = await scrapeAlibabaProducts(query);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(results, null, 2),
              },
            ],
          };
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
    }
  );

  const host = req.get("host") || "localhost:3010";
  const protocol = req.secure || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  const absoluteMessagesUrl = `${protocol}://${host}/messages`;
  
  console.log(`[SSE] Absolute messages endpoint: ${absoluteMessagesUrl}`);

  const connectionTransport = new SSEServerTransport(absoluteMessagesUrl, res);
  
  transports.set(connectionTransport.sessionId, connectionTransport);
  console.log(`[SSE] Session created: ${connectionTransport.sessionId}`);

  // Send a heartbeat comment every 15 seconds to keep the connection alive through Render/Cloudflare proxies
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(":\n\n");
      console.log(`[SSE] Heartbeat sent to session: ${connectionTransport.sessionId}`);
    } catch (err) {
      console.error(`[SSE] Failed to send heartbeat: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeatInterval);
    transports.delete(connectionTransport.sessionId);
    console.log(`[SSE] Session closed/cleaned: ${connectionTransport.sessionId}`);
  });

  await connectionServer.connect(connectionTransport);
});

// Handle message routing - support both /messages and root (/) POST requests
app.post(["/", "/messages"], async (req, res) => {
  const sessionId = (req.query.sessionId as string) || (req.body?.sessionId as string);
  console.log(`[MESSAGE] Incoming post message. Session ID: ${sessionId || "none"}`);
  
  let activeTransport: SSEServerTransport | undefined;
  
  if (sessionId) {
    activeTransport = transports.get(sessionId);
  } else if (transports.size === 1) {
    // Fallback: If no sessionId in request, but we only have 1 active session, use it
    activeTransport = transports.values().next().value;
    console.log(`[MESSAGE] No sessionId provided, falling back to sole active session: ${activeTransport?.sessionId}`);
  } else if (transports.size > 1) {
    // If multiple sessions exist, try to guess or use the most recent one
    activeTransport = Array.from(transports.values()).pop();
    console.log(`[MESSAGE] Multiple sessions. Guessing most recent session: ${activeTransport?.sessionId}`);
  }

  if (activeTransport) {
    await activeTransport.handlePostMessage(req, res);
  } else {
    console.warn(`[MESSAGE] Session not found for ID: ${sessionId || "none"}. Active sessions: ${transports.size}`);
    res.status(400).send("No active SSE session found");
  }
});

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
  console.log(`==========================================`);
  console.log(`MCP Server http://localhost:${PORT} uzerinde calisiyor`);
  console.log(`==========================================`);
});
