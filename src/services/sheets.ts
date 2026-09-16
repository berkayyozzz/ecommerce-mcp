import { google } from "googleapis";
import { JWT } from "google-auth-library";

// 1. Google API yapÄ±landÄ±rmasÄ±
function getSheetsClient() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GOOGLE_CLIENT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

  if (!clientEmail || !privateKey || !spreadsheetId) {
    throw new Error("Google Sheets kimlik bilgileri eksik (.env: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SPREADSHEET_ID)");
  }

  // Ensure private key has proper line breaks
  privateKey = privateKey.replace(/\\n/g, "\n");

  const auth = new JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  return { sheets, spreadsheetId };
}

// 2. Maliyet Gecmisi Alma
export async function getCostHistory(asin: string) {
  const { sheets, spreadsheetId } = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Product Costs!A2:K", // Timestamp, Tarih, ASIN, Product Name, Cost (USD), En, Boy, Yukseklik, Agirlik, Paket Durumu, Notes
  });

  const rows = response.data.values || [];
  const normalizedAsin = asin.trim().toUpperCase();
  const history = rows
    .filter((row) => (row[2] || "").trim().toUpperCase() === normalizedAsin)
    .map((row) => ({
      timestamp: row[0],
      tarih: row[1],
      asin: row[2],
      productName: row[3],
      cost: row[4],
      en: row[5],
      boy: row[6],
      yukseklik: row[7],
      agirlik: row[8],
      paketDurumu: row[9],
      notes: row[10] || "",
    }));

  return history;
}

// 3. Guncel Maliyet Alma
export async function getCurrentCost(asin: string) {
  const history = await getCostHistory(asin);
  if (history.length === 0) return null;
  return history[history.length - 1];
}

// 4. Maliyet Ekleme
export async function addCost(
  asin: string, 
  productName: string, 
  cost: number, 
  en?: number, 
  boy?: number, 
  yukseklik?: number, 
  agirlik?: number, 
  paketDurumu?: string, 
  notes: string = ""
) {
  const { sheets, spreadsheetId } = getSheetsClient();
  
  const normalizedAsin = asin.trim().toUpperCase();
  const previousRecord = await getCurrentCost(normalizedAsin);
  
  const timestamp = new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
  const dateOnly = new Date().toLocaleDateString("tr-TR", { timeZone: "Europe/Istanbul" });
  
  const finalProductName = productName || (previousRecord && previousRecord.productName) || "";
  const finalEn = en ?? (previousRecord && previousRecord.en) ?? "";
  const finalBoy = boy ?? (previousRecord && previousRecord.boy) ?? "";
  const finalYukseklik = yukseklik ?? (previousRecord && previousRecord.yukseklik) ?? "";
  const finalAgirlik = agirlik ?? (previousRecord && previousRecord.agirlik) ?? "";
  const finalPaketDurumu = paketDurumu || (previousRecord && previousRecord.paketDurumu) || "";

  const values = [[
    timestamp,
    dateOnly,
    normalizedAsin,
    finalProductName,
    cost,
    finalEn,
    finalBoy,
    finalYukseklik,
    finalAgirlik,
    finalPaketDurumu,
    notes
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Product Costs!A:K",
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });

  return { success: true, message: `Maliyet basariyla eklendi: ${normalizedAsin} - $${cost}` };
}

// 5. Stok Gecmisi Alma
export async function getStockHistory(asin: string) {
  const { sheets, spreadsheetId } = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Product Stock!A2:E", // Timestamp, ASIN, Product Name, Stock, Notes
  });

  const rows = response.data.values || [];
  const normalizedAsin = asin.trim().toUpperCase();
  const history = rows
    .filter((row) => (row[1] || "").trim().toUpperCase() === normalizedAsin)
    .map((row) => ({
      timestamp: row[0],
      asin: row[1],
      productName: row[2],
      stock: row[3],
      notes: row[4] || "",
    }));

  return history;
}

// 6. Guncel Stok Alma
export async function getCurrentStock(asin: string) {
  const history = await getStockHistory(asin);
  if (history.length === 0) return null;
  return history[history.length - 1];
}

// 7. Stok Ekleme
export async function addStock(asin: string, productName: string, stock: number, notes: string = "") {
  const { sheets, spreadsheetId } = getSheetsClient();
  const timestamp = new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
  
  const normalizedAsin = asin.trim().toUpperCase();
  const previousRecord = await getCurrentStock(normalizedAsin);
  const finalProductName = productName || (previousRecord && previousRecord.productName) || "";

  const values = [[
    timestamp,
    normalizedAsin,
    finalProductName,
    stock,
    notes
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Product Stock!A:E",
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });

  return { success: true, message: `Stok basariyla eklendi: ${normalizedAsin} - ${stock}` };
}

// 8. Tum Guncel Degerleri Listeleme
export async function listCurrentValues() {
  const { sheets, spreadsheetId } = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Current Values!A2:G",
  });

  const rows = response.data.values || [];
  return rows.map((row) => ({
    asin: row[0],
    productName: row[1],
    currentCost: row[2],
    currency: row[3] || "USD",
    currentStock: row[4],
    lastCostUpdate: row[5] || "",
    lastStockUpdate: row[6] || "",
  }));
}

export const sheetsTools = [
  {
    name: "get_current_cost",
    description: "Belirtilen ASIN icin en guncel maliyeti Google Sheets uzerinden dondurur.",
    inputSchema: {
      type: "object",
      properties: { asin: { type: "string" } },
      required: ["asin"],
    },
  },
  {
    name: "get_cost_history",
    description: "Belirtilen ASIN icin gecmis maliyet kayitlarini dondurur.",
    inputSchema: {
      type: "object",
      properties: { asin: { type: "string" } },
      required: ["asin"],
    },
  },
  {
    name: "add_cost",
    description: "Google Sheets'e YENI SATIR olarak urun maliyeti ekler. Eksik detaylar (or: productName, boyutlar) onceki kayitlardan otomatik tamamlanir.",
    inputSchema: {
      type: "object",
      properties: {
        asin: { type: "string" },
        product_name: { type: "string" },
        cost: { type: "number" },
        en: { type: "number", description: "En (cm)" },
        boy: { type: "number", description: "Boy (cm)" },
        yukseklik: { type: "number", description: "Yukseklik (cm)" },
        agirlik: { type: "number", description: "Agirlik (kg)" },
        paket_durumu: { type: "string" },
        notes: { type: "string", default: "" },
      },
      required: ["asin", "cost"],
    },
  },
  {
    name: "get_current_stock",
    description: "Belirtilen ASIN icin en guncel stoku dondurur.",
    inputSchema: {
      type: "object",
      properties: { asin: { type: "string" } },
      required: ["asin"],
    },
  },
  {
    name: "get_stock_history",
    description: "Belirtilen ASIN icin gecmis stok kayitlarini dondurur.",
    inputSchema: {
      type: "object",
      properties: { asin: { type: "string" } },
      required: ["asin"],
    },
  },
  {
    name: "add_stock",
    description: "Google Sheets'e YENI SATIR olarak urun stoku ekler.",
    inputSchema: {
      type: "object",
      properties: {
        asin: { type: "string" },
        product_name: { type: "string" },
        stock: { type: "number" },
        notes: { type: "string", default: "" },
      },
      required: ["asin", "stock"],
    },
  },
  {
    name: "list_current_values",
    description: "Current Values sekmesindeki tum urunlerin guncel maliyet ve stok durumlarini listeler.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];
