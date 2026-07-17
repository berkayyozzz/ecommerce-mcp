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

  const connectionTransport = new SSEServerTransport("/messages", res);
  
  transports.set(connectionTransport.sessionId, connectionTransport);
  console.log(`[SSE] Session created: ${connectionTransport.sessionId}`);

  req.on("close", () => {
    transports.delete(connectionTransport.sessionId);
    console.log(`[SSE] Session closed/cleaned: ${connectionTransport.sessionId}`);
  });

  await connectionServer.connect(connectionTransport);
});

// Handle message routing
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  console.log(`[MESSAGE] Incoming post message for session: ${sessionId}`);
  
  const activeTransport = transports.get(sessionId);
  if (activeTransport) {
    await activeTransport.handlePostMessage(req, res);
  } else {
    console.warn(`[MESSAGE] Session not found for ID: ${sessionId}`);
    res.status(400).send("No active SSE session found");
  }
});

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
  console.log(`==========================================`);
  console.log(`MCP Server http://localhost:${PORT} uzerinde calisiyor`);
  console.log(`==========================================`);
});
