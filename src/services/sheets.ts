import { google } from "googleapis";
import { JWT } from "google-auth-library";

type SheetRow = Array<string | number | boolean | null | undefined>;
type HeaderDefinitions = Record<string, readonly string[]>;
type HeaderIndexes<T extends HeaderDefinitions> = { [K in keyof T]: number };

const PRODUCT_COSTS_SHEET = "Product Costs";
const PRODUCT_COSTS_RANGE = "'Product Costs'!A:Q";
const PRODUCT_STOCK_SHEET = "Product Stock";
const CURRENT_VALUES_SHEET = "Current Values";

const costHeaders = {
  timestamp: ["Timestamp"], asin: ["ASIN"], productName: ["İSİM"], cost: ["COST(USD)"],
  en: ["EN"], boy: ["BOY"], yukseklik: ["YÜKSEKLİK"], agirlik: ["AĞIRLIK"],
  paketDurumu: ["PAKETLİ PAKETSİZ"], notes: ["NOT"],
} as const;

const stockHeaders = {
  timestamp: ["Timestamp"], asin: ["ASIN"], productName: ["İSİM", "Product Name"],
  stock: ["STOK", "Stock"], notes: ["NOT", "Notes"],
} as const;

const currentValueHeaders = {
  asin: ["ASIN"], productName: ["İSİM", "Product Name"],
  currentCost: ["GÜNCEL MALİYET", "Current Cost"], currency: ["PARA BİRİMİ", "Currency"],
  currentStock: ["GÜNCEL STOK", "Current Stock"],
  lastCostUpdate: ["SON MALİYET GÜNCELLEMESİ", "Last Cost Update"],
  lastStockUpdate: ["SON STOK GÜNCELLEMESİ", "Last Stock Update"],
} as const;

export function normalizeSheetHeader(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function resolveHeaderIndexes<T extends HeaderDefinitions>(
  sheetName: string,
  headers: SheetRow,
  definitions: T,
): HeaderIndexes<T> {
  const normalizedHeaders = headers.map(normalizeSheetHeader);
  const result = {} as HeaderIndexes<T>;

  for (const key of Object.keys(definitions) as Array<keyof T>) {
    const acceptedNames = definitions[key].map(normalizeSheetHeader);
    const matches = normalizedHeaders
      .map((header, index) => (acceptedNames.includes(header) ? index : -1))
      .filter((index) => index >= 0);
    if (matches.length === 0) {
      throw new Error(`${sheetName} sekmesinde gerekli baslik bulunamadi: ${definitions[key].join(" / ")}`);
    }
    if (matches.length > 1) {
      throw new Error(`${sheetName} sekmesinde ayni alana uyan birden fazla baslik var: ${definitions[key].join(" / ")}`);
    }
    result[key] = matches[0];
  }
  return result;
}

function quoteSheetName(sheetName: string): string {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

function columnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function columnIndex(column: string): number {
  return column
    .toUpperCase()
    .split("")
    .reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0) - 1;
}

function parseUpdatedRange(updatedRange: string) {
  const match = updatedRange.match(/!([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!match) throw new Error(`Append sonucundaki satir araligi okunamadi: ${updatedRange}`);
  return {
    startColumnIndex: columnIndex(match[1]),
    endColumnIndex: columnIndex(match[3]) + 1,
    startRowIndex: Number(match[2]) - 1,
    endRowIndex: Number(match[4]),
  };
}

async function extendTableAfterAppend(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  sheetName: string,
  updatedRange: string | null | undefined,
) {
  if (!updatedRange) throw new Error(`${sheetName} append islemi yeni satir araligi dondurmedi.`);
  const appendedRange = parseUpdatedRange(updatedRange);
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [quoteSheetName(sheetName)],
    fields: "sheets.tables",
  });
  const tables = (metadata.data.sheets || []).flatMap((sheet) => sheet.tables || []);
  if (tables.length === 0) return;

  const columnMatches = tables.filter((table) => {
    const range = table.range;
    if (!range) return false;
    const startColumn = range.startColumnIndex ?? 0;
    const endColumn = range.endColumnIndex ?? Number.POSITIVE_INFINITY;
    return startColumn <= appendedRange.startColumnIndex && endColumn >= appendedRange.endColumnIndex;
  });

  // Sheets bazen tabloyu kendisi genisletebilir. Zaten kapsiyorsa ikinci bir bos satir ekleme.
  if (columnMatches.some((table) => {
    const range = table.range!;
    const startRow = range.startRowIndex ?? 0;
    const endRow = range.endRowIndex ?? Number.POSITIVE_INFINITY;
    return startRow <= appendedRange.startRowIndex && endRow >= appendedRange.endRowIndex;
  })) return;

  const table = columnMatches.find(
    (candidate) => candidate.range?.endRowIndex === appendedRange.startRowIndex,
  );
  if (!table?.tableId || !table.range) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        updateTable: {
          table: {
            tableId: table.tableId,
            range: { ...table.range, endRowIndex: appendedRange.endRowIndex },
          },
          fields: "range",
        },
      }],
    },
  });
}

function cell(row: SheetRow, index: number) {
  return row[index] ?? "";
}

function getSheetsClient() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GOOGLE_CLIENT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!clientEmail || !privateKey || !spreadsheetId) {
    throw new Error("Google Sheets kimlik bilgileri eksik (.env: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SPREADSHEET_ID)");
  }
  privateKey = privateKey.replace(/\\n/g, "\n");
  const auth = new JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return { sheets: google.sheets({ version: "v4", auth }), spreadsheetId };
}

async function readRows(range: string) {
  const { sheets, spreadsheetId } = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return { sheets, spreadsheetId, rows: (response.data.values || []) as SheetRow[] };
}

function requireHeaderRow(sheetName: string, rows: SheetRow[]): SheetRow {
  if (!rows[0]?.length) throw new Error(`${sheetName} sekmesinin 1. satirinda baslik bulunamadi.`);
  return rows[0];
}

function mapCostRow(row: SheetRow, indexes: HeaderIndexes<typeof costHeaders>) {
  return {
    timestamp: cell(row, indexes.timestamp), asin: cell(row, indexes.asin),
    productName: cell(row, indexes.productName), cost: cell(row, indexes.cost),
    en: cell(row, indexes.en), boy: cell(row, indexes.boy),
    yukseklik: cell(row, indexes.yukseklik), agirlik: cell(row, indexes.agirlik),
    paketDurumu: cell(row, indexes.paketDurumu), notes: cell(row, indexes.notes),
  };
}

async function readCostTable() {
  const result = await readRows(PRODUCT_COSTS_RANGE);
  const headers = requireHeaderRow(PRODUCT_COSTS_SHEET, result.rows);
  const indexes = resolveHeaderIndexes(PRODUCT_COSTS_SHEET, headers, costHeaders);
  return { ...result, headers, indexes, dataRows: result.rows.slice(1) };
}

export async function getCostHistory(asin: string) {
  const { indexes, dataRows } = await readCostTable();
  const normalizedAsin = asin.trim().toUpperCase();
  return dataRows
    .filter((row) => String(cell(row, indexes.asin)).trim().toUpperCase() === normalizedAsin)
    .map((row) => mapCostRow(row, indexes));
}

export async function getCurrentCost(asin: string) {
  const history = await getCostHistory(asin);
  return history.length === 0 ? null : history[history.length - 1];
}

export async function addCost(
  asin: string, productName: string, cost: number, en?: number, boy?: number,
  yukseklik?: number, agirlik?: number, paketDurumu?: string, _notes: string = "",
) {
  const { sheets, spreadsheetId, indexes, dataRows } = await readCostTable();
  const normalizedAsin = asin.trim().toUpperCase();
  const priorRows = dataRows.filter(
    (row) => String(cell(row, indexes.asin)).trim().toUpperCase() === normalizedAsin,
  );
  const previousRecord = priorRows.length ? mapCostRow(priorRows[priorRows.length - 1], indexes) : null;

  // A:Q araligini koru; eslenmeyen (ozellikle gizli E:K) hucrelerde null kullanmak
  // Sheets API'ye bu hucreleri atlamasini, yani bir deger yazmamasini soyler.
  const values: SheetRow = Array(17).fill(null);
  values[indexes.timestamp] = new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
  values[indexes.asin] = normalizedAsin;
  values[indexes.productName] = productName || previousRecord?.productName || "";
  values[indexes.cost] = cost;
  values[indexes.en] = en ?? previousRecord?.en ?? "";
  values[indexes.boy] = boy ?? previousRecord?.boy ?? "";
  values[indexes.yukseklik] = yukseklik ?? previousRecord?.yukseklik ?? "";
  values[indexes.agirlik] = agirlik ?? previousRecord?.agirlik ?? "";
  values[indexes.paketDurumu] = paketDurumu || previousRecord?.paketDurumu || "";
  values[indexes.notes] = "Ürün Maliyeti";

  const appendResponse = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: PRODUCT_COSTS_RANGE,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] },
  });
  await extendTableAfterAppend(
    sheets,
    spreadsheetId,
    PRODUCT_COSTS_SHEET,
    appendResponse.data.updates?.updatedRange,
  );
  return { success: true, message: `Maliyet basariyla eklendi: ${normalizedAsin} - $${cost}` };
}

async function readStockTable() {
  const headerResult = await readRows(`${quoteSheetName(PRODUCT_STOCK_SHEET)}!1:1`);
  const headers = requireHeaderRow(PRODUCT_STOCK_SHEET, headerResult.rows);
  const indexes = resolveHeaderIndexes(PRODUCT_STOCK_SHEET, headers, stockHeaders);
  const lastColumn = columnName(headers.length - 1);
  const dataResponse = await headerResult.sheets.spreadsheets.values.get({
    spreadsheetId: headerResult.spreadsheetId,
    range: `${quoteSheetName(PRODUCT_STOCK_SHEET)}!A2:${lastColumn}`,
  });
  return {
    ...headerResult, headers, indexes,
    dataRows: (dataResponse.data.values || []) as SheetRow[],
    range: `${quoteSheetName(PRODUCT_STOCK_SHEET)}!A:${lastColumn}`,
  };
}

function mapStockRow(row: SheetRow, indexes: HeaderIndexes<typeof stockHeaders>) {
  return {
    timestamp: cell(row, indexes.timestamp), asin: cell(row, indexes.asin),
    productName: cell(row, indexes.productName), stock: cell(row, indexes.stock),
    notes: cell(row, indexes.notes),
  };
}

export async function getStockHistory(asin: string) {
  const { indexes, dataRows } = await readStockTable();
  const normalizedAsin = asin.trim().toUpperCase();
  return dataRows
    .filter((row) => String(cell(row, indexes.asin)).trim().toUpperCase() === normalizedAsin)
    .map((row) => mapStockRow(row, indexes));
}

export async function getCurrentStock(asin: string) {
  const history = await getStockHistory(asin);
  return history.length === 0 ? null : history[history.length - 1];
}

export async function addStock(asin: string, productName: string, stock: number, notes: string = "") {
  const { sheets, spreadsheetId, headers, indexes, dataRows, range } = await readStockTable();
  const normalizedAsin = asin.trim().toUpperCase();
  const priorRows = dataRows.filter(
    (row) => String(cell(row, indexes.asin)).trim().toUpperCase() === normalizedAsin,
  );
  const previousRecord = priorRows.length ? mapStockRow(priorRows[priorRows.length - 1], indexes) : null;

  const values: SheetRow = Array(headers.length).fill(null);
  values[indexes.timestamp] = new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
  values[indexes.asin] = normalizedAsin;
  values[indexes.productName] = productName || previousRecord?.productName || "";
  values[indexes.stock] = stock;
  values[indexes.notes] = notes;

  const appendResponse = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] },
  });
  await extendTableAfterAppend(
    sheets,
    spreadsheetId,
    PRODUCT_STOCK_SHEET,
    appendResponse.data.updates?.updatedRange,
  );
  return { success: true, message: `Stok basariyla eklendi: ${normalizedAsin} - ${stock}` };
}

export async function listCurrentValues() {
  const { rows } = await readRows(quoteSheetName(CURRENT_VALUES_SHEET));
  const headers = requireHeaderRow(CURRENT_VALUES_SHEET, rows);
  const indexes = resolveHeaderIndexes(CURRENT_VALUES_SHEET, headers, currentValueHeaders);
  return rows.slice(1).map((row) => ({
    asin: cell(row, indexes.asin), productName: cell(row, indexes.productName),
    currentCost: cell(row, indexes.currentCost), currency: cell(row, indexes.currency) || "USD",
    currentStock: cell(row, indexes.currentStock), lastCostUpdate: cell(row, indexes.lastCostUpdate),
    lastStockUpdate: cell(row, indexes.lastStockUpdate),
  }));
}

export const sheetsTools = [
  { name: "get_current_cost", description: "Belirtilen ASIN icin en guncel maliyeti Google Sheets uzerinden dondurur.", inputSchema: { type: "object", properties: { asin: { type: "string" } }, required: ["asin"] } },
  { name: "get_cost_history", description: "Belirtilen ASIN icin gecmis maliyet kayitlarini dondurur.", inputSchema: { type: "object", properties: { asin: { type: "string" } }, required: ["asin"] } },
  {
    name: "add_cost",
    description: "Google Sheets'e YENI SATIR olarak urun maliyeti ekler. Eksik detaylar (or: productName, boyutlar) onceki kayitlardan otomatik tamamlanir.",
    inputSchema: {
      type: "object",
      properties: {
        asin: { type: "string" }, product_name: { type: "string" }, cost: { type: "number" },
        en: { type: "number", description: "En (cm)" }, boy: { type: "number", description: "Boy (cm)" },
        yukseklik: { type: "number", description: "Yukseklik (cm)" },
        agirlik: { type: "number", description: "Agirlik (kg)" }, paket_durumu: { type: "string" },
        notes: { type: "string", default: "" },
      },
      required: ["asin", "cost"],
    },
  },
  { name: "get_current_stock", description: "Belirtilen ASIN icin en guncel stoku dondurur.", inputSchema: { type: "object", properties: { asin: { type: "string" } }, required: ["asin"] } },
  { name: "get_stock_history", description: "Belirtilen ASIN icin gecmis stok kayitlarini dondurur.", inputSchema: { type: "object", properties: { asin: { type: "string" } }, required: ["asin"] } },
  {
    name: "add_stock", description: "Google Sheets'e YENI SATIR olarak urun stoku ekler.",
    inputSchema: { type: "object", properties: { asin: { type: "string" }, product_name: { type: "string" }, stock: { type: "number" }, notes: { type: "string", default: "" } }, required: ["asin", "stock"] },
  },
  { name: "list_current_values", description: "Current Values sekmesindeki tum urunlerin guncel maliyet ve stok durumlarini listeler.", inputSchema: { type: "object", properties: {} } },
];
