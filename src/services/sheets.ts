import { google } from "googleapis";
import { JWT } from "google-auth-library";

type SheetRow = Array<string | number | boolean | null | undefined>;
type HeaderDefinitions = Record<string, readonly string[]>;
type HeaderIndexes<T extends HeaderDefinitions> = { [K in keyof T]: number };

export type RowFilters = {
  asinPrefix?: string;
  dateFrom?: string;
  dateTo?: string;
};

export type CostInput = {
  asin: string;
  productName?: string;
  cost: number;
  en?: number;
  boy?: number;
  yukseklik?: number;
  agirlik?: number;
  paketDurumu?: string;
};

export type StockInput = {
  asin: string;
  productName?: string;
  stock: number;
  notes?: string;
};

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

function normalizedAsin(value: unknown): string {
  const asin = String(value ?? "").trim().toUpperCase();
  if (!asin) throw new Error("ASIN bos olamaz.");
  return asin;
}

export function formatSheetTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";

  return `${part("month")}/${part("day")}/${part("year")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

function currentTimestamp(): string {
  return formatSheetTimestamp(new Date());
}

export function sheetDateKey(value: unknown): string | null {
  const text = String(value ?? "").trim();
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const dottedDayFirst = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dottedDayFirst) {
    return `${dottedDayFirst[3]}-${dottedDayFirst[2].padStart(2, "0")}-${dottedDayFirst[1].padStart(2, "0")}`;
  }
  const slashedMonthFirst = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashedMonthFirst) {
    return `${slashedMonthFirst[3]}-${slashedMonthFirst[1].padStart(2, "0")}-${slashedMonthFirst[2].padStart(2, "0")}`;
  }
  return null;
}

function validateDateFilter(name: string, value?: string) {
  if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} YYYY-MM-DD formatinda olmali.`);
  }
}

function matchesFilters(record: { asin: unknown; timestamp: unknown }, filters: RowFilters): boolean {
  const prefix = String(filters.asinPrefix ?? "").trim().toUpperCase();
  if (prefix && !String(record.asin ?? "").trim().toUpperCase().startsWith(prefix)) return false;
  if (!filters.dateFrom && !filters.dateTo) return true;
  const date = sheetDateKey(record.timestamp);
  if (!date) return false;
  return (!filters.dateFrom || date >= filters.dateFrom) && (!filters.dateTo || date <= filters.dateTo);
}

function summarizeRows<T extends { asin: unknown }>(rows: T[]) {
  return {
    count: rows.length,
    uniqueAsinCount: new Set(rows.map((row) => String(row.asin ?? "").trim().toUpperCase()).filter(Boolean)).size,
    rows,
  };
}

function latestByAsin<T extends { asin: unknown }>(rows: T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const asin = String(row.asin ?? "").trim().toUpperCase();
    if (asin) latest.set(asin, row);
  }
  return latest;
}

function mapCostRow(row: SheetRow, indexes: HeaderIndexes<typeof costHeaders>, rowNumber?: number) {
  return {
    ...(rowNumber === undefined ? {} : { rowNumber }),
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
  const normalized = normalizedAsin(asin);
  return dataRows
    .map((row, index) => mapCostRow(row, indexes, index + 2))
    .filter((row) => String(row.asin).trim().toUpperCase() === normalized);
}

export async function getCurrentCost(asin: string) {
  const history = await getCostHistory(asin);
  return history.length === 0 ? null : history[history.length - 1];
}

export async function listAllCosts(filters: RowFilters = {}) {
  validateDateFilter("date_from", filters.dateFrom);
  validateDateFilter("date_to", filters.dateTo);
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
    throw new Error("date_from, date_to degerinden sonra olamaz.");
  }
  const { indexes, dataRows } = await readCostTable();
  const rows = dataRows
    .map((row, index) => mapCostRow(row, indexes, index + 2))
    .filter((row) => String(row.asin).trim())
    .filter((row) => matchesFilters(row, filters));
  return summarizeRows(rows);
}

async function appendCosts(records: CostInput[]) {
  if (records.length === 0) throw new Error("En az bir maliyet kaydi gerekli.");
  if (records.length > 500) throw new Error("Tek cagrida en fazla 500 maliyet kaydi eklenebilir.");
  const { sheets, spreadsheetId, indexes, dataRows } = await readCostTable();
  const currentRecords = latestByAsin(dataRows.map((row) => mapCostRow(row, indexes)));
  const timestamp = currentTimestamp();
  const normalizedRecords: CostInput[] = [];
  const values = records.map((record) => {
    const asin = normalizedAsin(record.asin);
    if (!Number.isFinite(record.cost)) throw new Error(`${asin} icin cost gecerli bir sayi olmali.`);
    const previous = currentRecords.get(asin);
    const normalizedRecord: CostInput = {
      asin,
      productName: record.productName || String(previous?.productName ?? ""),
      cost: record.cost,
      en: record.en ?? previous?.en as number | undefined,
      boy: record.boy ?? previous?.boy as number | undefined,
      yukseklik: record.yukseklik ?? previous?.yukseklik as number | undefined,
      agirlik: record.agirlik ?? previous?.agirlik as number | undefined,
      paketDurumu: record.paketDurumu || String(previous?.paketDurumu ?? ""),
    };
    normalizedRecords.push(normalizedRecord);

    const row: SheetRow = Array(17).fill(null);
    row[indexes.timestamp] = timestamp;
    row[indexes.asin] = asin;
    row[indexes.productName] = normalizedRecord.productName || "";
    row[indexes.cost] = normalizedRecord.cost;
    row[indexes.en] = normalizedRecord.en ?? "";
    row[indexes.boy] = normalizedRecord.boy ?? "";
    row[indexes.yukseklik] = normalizedRecord.yukseklik ?? "";
    row[indexes.agirlik] = normalizedRecord.agirlik ?? "";
    row[indexes.paketDurumu] = normalizedRecord.paketDurumu || "";
    row[indexes.notes] = "Ürün Maliyeti";
    currentRecords.set(asin, mapCostRow(row, indexes));
    return row;
  });

  const appendResponse = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: PRODUCT_COSTS_RANGE,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
  await extendTableAfterAppend(
    sheets,
    spreadsheetId,
    PRODUCT_COSTS_SHEET,
    appendResponse.data.updates?.updatedRange,
  );
  return normalizedRecords;
}

export async function addCost(
  asin: string, productName: string, cost: number, en?: number, boy?: number,
  yukseklik?: number, agirlik?: number, paketDurumu?: string, _notes: string = "",
) {
  const [record] = await appendCosts([{ asin, productName, cost, en, boy, yukseklik, agirlik, paketDurumu }]);
  return { success: true, message: `Maliyet basariyla eklendi: ${record.asin} - $${record.cost}` };
}

export async function addCostBulk(records: CostInput[]) {
  const added = await appendCosts(records);
  return { success: true, addedCount: added.length, asins: added.map((record) => record.asin) };
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

function mapStockRow(row: SheetRow, indexes: HeaderIndexes<typeof stockHeaders>, rowNumber?: number) {
  return {
    ...(rowNumber === undefined ? {} : { rowNumber }),
    timestamp: cell(row, indexes.timestamp), asin: cell(row, indexes.asin),
    productName: cell(row, indexes.productName), stock: cell(row, indexes.stock),
    notes: cell(row, indexes.notes),
  };
}

export async function getStockHistory(asin: string) {
  const { indexes, dataRows } = await readStockTable();
  const normalized = normalizedAsin(asin);
  return dataRows
    .map((row, index) => mapStockRow(row, indexes, index + 2))
    .filter((row) => String(row.asin).trim().toUpperCase() === normalized);
}

export async function getCurrentStock(asin: string) {
  const history = await getStockHistory(asin);
  return history.length === 0 ? null : history[history.length - 1];
}

export async function listAllStocks(filters: RowFilters = {}) {
  validateDateFilter("date_from", filters.dateFrom);
  validateDateFilter("date_to", filters.dateTo);
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
    throw new Error("date_from, date_to degerinden sonra olamaz.");
  }
  const { indexes, dataRows } = await readStockTable();
  const rows = dataRows
    .map((row, index) => mapStockRow(row, indexes, index + 2))
    .filter((row) => String(row.asin).trim())
    .filter((row) => matchesFilters(row, filters));
  return summarizeRows(rows);
}

async function appendStocks(records: StockInput[]) {
  if (records.length === 0) throw new Error("En az bir stok kaydi gerekli.");
  if (records.length > 500) throw new Error("Tek cagrida en fazla 500 stok kaydi eklenebilir.");
  const { sheets, spreadsheetId, headers, indexes, dataRows, range } = await readStockTable();
  const currentRecords = latestByAsin(dataRows.map((row) => mapStockRow(row, indexes)));
  const timestamp = currentTimestamp();
  const normalizedRecords: StockInput[] = [];
  const values = records.map((record) => {
    const asin = normalizedAsin(record.asin);
    if (!Number.isFinite(record.stock)) throw new Error(`${asin} icin stock gecerli bir sayi olmali.`);
    const previous = currentRecords.get(asin);
    const normalizedRecord: StockInput = {
      asin,
      productName: record.productName || String(previous?.productName ?? ""),
      stock: record.stock,
      notes: record.notes ?? "",
    };
    normalizedRecords.push(normalizedRecord);

    const row: SheetRow = Array(headers.length).fill(null);
    row[indexes.timestamp] = timestamp;
    row[indexes.asin] = asin;
    row[indexes.productName] = normalizedRecord.productName || "";
    row[indexes.stock] = normalizedRecord.stock;
    row[indexes.notes] = normalizedRecord.notes || "";
    currentRecords.set(asin, mapStockRow(row, indexes));
    return row;
  });

  const appendResponse = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
  await extendTableAfterAppend(
    sheets,
    spreadsheetId,
    PRODUCT_STOCK_SHEET,
    appendResponse.data.updates?.updatedRange,
  );
  return normalizedRecords;
}

export async function addStock(asin: string, productName: string, stock: number, notes: string = "") {
  const [record] = await appendStocks([{ asin, productName, stock, notes }]);
  return { success: true, message: `Stok basariyla eklendi: ${record.asin} - ${record.stock}` };
}

export async function addStockBulk(records: StockInput[]) {
  const added = await appendStocks(records);
  return { success: true, addedCount: added.length, asins: added.map((record) => record.asin) };
}

async function readCurrentValuesTable() {
  const result = await readRows(quoteSheetName(CURRENT_VALUES_SHEET));
  const headers = requireHeaderRow(CURRENT_VALUES_SHEET, result.rows);
  const indexes = resolveHeaderIndexes(CURRENT_VALUES_SHEET, headers, currentValueHeaders);
  const lastColumn = columnName(headers.length - 1);
  return {
    ...result,
    headers,
    indexes,
    dataRows: result.rows.slice(1),
    range: `${quoteSheetName(CURRENT_VALUES_SHEET)}!A:${lastColumn}`,
    lastColumn,
  };
}

function mapCurrentValueRow(row: SheetRow, indexes: HeaderIndexes<typeof currentValueHeaders>, rowNumber?: number) {
  return {
    ...(rowNumber === undefined ? {} : { rowNumber }),
    asin: cell(row, indexes.asin), productName: cell(row, indexes.productName),
    currentCost: cell(row, indexes.currentCost), currency: cell(row, indexes.currency) || "USD",
    currentStock: cell(row, indexes.currentStock), lastCostUpdate: cell(row, indexes.lastCostUpdate),
    lastStockUpdate: cell(row, indexes.lastStockUpdate),
  };
}

export async function listCurrentValues() {
  const { indexes, dataRows } = await readCurrentValuesTable();
  return dataRows
    .map((row, index) => mapCurrentValueRow(row, indexes, index + 2))
    .filter((row) => String(row.asin).trim());
}

export async function updateCurrentValues() {
  const [costTable, stockTable, currentTable] = await Promise.all([
    readCostTable(),
    readStockTable(),
    readCurrentValuesTable(),
  ]);
  const latestCosts = latestByAsin(
    costTable.dataRows.map((row, index) => mapCostRow(row, costTable.indexes, index + 2)),
  );
  const latestStocks = latestByAsin(
    stockTable.dataRows.map((row, index) => mapStockRow(row, stockTable.indexes, index + 2)),
  );
  const existingRows = new Map<string, number>();
  for (const [index, row] of currentTable.dataRows.entries()) {
    const asin = String(cell(row, currentTable.indexes.asin)).trim().toUpperCase();
    if (!asin) continue;
    if (existingRows.has(asin)) throw new Error(`Current Values sekmesinde mukerrer ASIN var: ${asin}`);
    existingRows.set(asin, index + 2);
  }

  const asins = [...new Set([...latestCosts.keys(), ...latestStocks.keys()])].sort();
  const sourceAsins = new Set(asins);
  const updates: Array<{ range: string; values: SheetRow[] }> = [];
  const appends: SheetRow[] = [];
  for (const asin of asins) {
    const cost = latestCosts.get(asin);
    const stock = latestStocks.get(asin);
    const row: SheetRow = Array(currentTable.headers.length).fill(null);
    row[currentTable.indexes.asin] = asin;
    row[currentTable.indexes.productName] = String(cost?.productName || stock?.productName || "");
    row[currentTable.indexes.currentCost] = cost?.cost ?? "";
    row[currentTable.indexes.currency] = "USD";
    row[currentTable.indexes.currentStock] = stock?.stock ?? "";
    row[currentTable.indexes.lastCostUpdate] = cost?.timestamp ?? "";
    row[currentTable.indexes.lastStockUpdate] = stock?.timestamp ?? "";
    const rowNumber = existingRows.get(asin);
    if (rowNumber) {
      updates.push({
        range: `${quoteSheetName(CURRENT_VALUES_SHEET)}!A${rowNumber}:${currentTable.lastColumn}${rowNumber}`,
        values: [row],
      });
    } else {
      appends.push(row);
    }
  }
  const staleRanges = [...existingRows.entries()]
    .filter(([asin]) => !sourceAsins.has(asin))
    .map(([, rowNumber]) =>
      `${quoteSheetName(CURRENT_VALUES_SHEET)}!A${rowNumber}:${currentTable.lastColumn}${rowNumber}`,
    );

  if (updates.length) {
    await currentTable.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: currentTable.spreadsheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data: updates },
    });
  }
  if (staleRanges.length) {
    await currentTable.sheets.spreadsheets.values.batchClear({
      spreadsheetId: currentTable.spreadsheetId,
      requestBody: { ranges: staleRanges },
    });
  }
  if (appends.length) {
    const appendResponse = await currentTable.sheets.spreadsheets.values.append({
      spreadsheetId: currentTable.spreadsheetId,
      range: currentTable.range,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: appends },
    });
    await extendTableAfterAppend(
      currentTable.sheets,
      currentTable.spreadsheetId,
      CURRENT_VALUES_SHEET,
      appendResponse.data.updates?.updatedRange,
    );
  }
  return {
    success: true,
    sourceAsinCount: asins.length,
    updatedCount: updates.length,
    addedCount: appends.length,
    clearedStaleCount: staleRanges.length,
  };
}

function normalizeProductText(value: unknown): string {
  return normalizeSheetHeader(value).replace(/[^a-z0-9]+/g, " ").trim();
}

export async function findProducts(query: string) {
  const search = normalizeProductText(query);
  if (!search) throw new Error("Arama metni bos olamaz.");
  const [costTable, stockTable] = await Promise.all([readCostTable(), readStockTable()]);
  const latestCosts = latestByAsin(costTable.dataRows.map((row) => mapCostRow(row, costTable.indexes)));
  const latestStocks = latestByAsin(stockTable.dataRows.map((row) => mapStockRow(row, stockTable.indexes)));
  const asins = [...new Set([...latestCosts.keys(), ...latestStocks.keys()])].sort();
  const products = asins.map((asin) => {
    const cost = latestCosts.get(asin);
    const stock = latestStocks.get(asin);
    return {
      asin,
      productName: String(cost?.productName || stock?.productName || ""),
      currentCost: cost?.cost ?? "",
      currentStock: stock?.stock ?? "",
      lastCostUpdate: cost?.timestamp ?? "",
      lastStockUpdate: stock?.timestamp ?? "",
    };
  }).filter((product) =>
    normalizeProductText(product.asin).includes(search) || normalizeProductText(product.productName).includes(search),
  );
  return { count: products.length, products };
}

export async function cloneCost(sourceAsin: string, targetAsins: string[]) {
  const source = await getCurrentCost(sourceAsin);
  if (!source) throw new Error(`Kaynak ASIN icin maliyet kaydi bulunamadi: ${normalizedAsin(sourceAsin)}`);
  const sourceNormalized = normalizedAsin(sourceAsin);
  const targets = [...new Set(targetAsins.map(normalizedAsin))].filter((asin) => asin !== sourceNormalized);
  if (targets.length === 0) throw new Error("Kaynak ASIN'den farkli en az bir hedef ASIN gerekli.");
  const result = await addCostBulk(targets.map((asin) => ({
    asin,
    productName: String(source.productName ?? ""),
    cost: Number(source.cost),
    en: source.en === "" ? undefined : Number(source.en),
    boy: source.boy === "" ? undefined : Number(source.boy),
    yukseklik: source.yukseklik === "" ? undefined : Number(source.yukseklik),
    agirlik: source.agirlik === "" ? undefined : Number(source.agirlik),
    paketDurumu: String(source.paketDurumu ?? ""),
  })));
  return { ...result, sourceAsin: sourceNormalized };
}

export async function getMissingFields() {
  const { indexes, dataRows } = await readCostTable();
  const latest = latestByAsin(dataRows.map((row, index) => mapCostRow(row, indexes, index + 2)));
  const rows = [...latest.values()].map((row) => {
    const missingFields: string[] = [];
    if (!String(row.productName ?? "").trim()) missingFields.push("productName");
    if (row.agirlik === "" || row.agirlik === null || row.agirlik === undefined) missingFields.push("agirlik");
    if (!String(row.paketDurumu ?? "").trim()) missingFields.push("paketDurumu");
    return { ...row, missingFields };
  }).filter((row) => row.missingFields.length > 0);
  return { count: rows.length, rows };
}

export async function findDuplicates() {
  const { indexes, dataRows } = await readCostTable();
  const rows = dataRows
    .map((row, index) => mapCostRow(row, indexes, index + 2))
    .filter((row) => String(row.asin).trim());
  const namesByAsin = new Map<string, Map<string, { productName: string; rowNumbers: number[] }>>();
  const asinsByName = new Map<string, Map<string, number[]>>();
  for (const row of rows) {
    const asin = String(row.asin).trim().toUpperCase();
    const productName = String(row.productName ?? "").trim();
    const nameKey = normalizeProductText(productName);
    if (nameKey) {
      const names = namesByAsin.get(asin) || new Map();
      const nameEntry = names.get(nameKey) || { productName, rowNumbers: [] };
      nameEntry.rowNumbers.push(row.rowNumber!);
      names.set(nameKey, nameEntry);
      namesByAsin.set(asin, names);

      const asins = asinsByName.get(nameKey) || new Map();
      const rowNumbers = asins.get(asin) || [];
      rowNumbers.push(row.rowNumber!);
      asins.set(asin, rowNumbers);
      asinsByName.set(nameKey, asins);
    }
  }
  const sameAsinDifferentNames = [...namesByAsin.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([asin, names]) => ({ asin, names: [...names.values()] }));
  const sameNameDifferentAsins = [...asinsByName.entries()]
    .filter(([, asins]) => asins.size > 1)
    .map(([normalizedName, asins]) => ({
      normalizedName,
      asins: [...asins.entries()].map(([asin, rowNumbers]) => ({ asin, rowNumbers })),
    }));
  return {
    sameAsinDifferentNamesCount: sameAsinDifferentNames.length,
    sameNameDifferentAsinsCount: sameNameDifferentAsins.length,
    sameAsinDifferentNames,
    sameNameDifferentAsins,
  };
}

export async function markRowDeleted(sheet: "cost" | "stock", rowNumber: number, asin: string) {
  if (sheet !== "cost" && sheet !== "stock") throw new Error("sheet cost veya stock olmali.");
  if (!Number.isInteger(rowNumber) || rowNumber < 2) throw new Error("row_number 2 veya daha buyuk bir tam sayi olmali.");
  const table = sheet === "cost" ? await readCostTable() : await readStockTable();
  const row = table.dataRows[rowNumber - 2];
  if (!row) throw new Error(`${rowNumber}. satir bulunamadi.`);
  const expectedAsin = normalizedAsin(asin);
  const actualAsin = String(cell(row, table.indexes.asin)).trim().toUpperCase();
  if (actualAsin !== expectedAsin) {
    throw new Error(`Satir guvenlik kontrolu basarisiz: ${rowNumber}. satirda ${actualAsin || "bos"} var.`);
  }
  const sheetName = sheet === "cost" ? PRODUCT_COSTS_SHEET : PRODUCT_STOCK_SHEET;
  const noteCell = `${quoteSheetName(sheetName)}!${columnName(table.indexes.notes)}${rowNumber}`;
  await table.sheets.spreadsheets.values.update({
    spreadsheetId: table.spreadsheetId,
    range: noteCell,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [["SİLİNECEK"]] },
  });
  return { success: true, sheet: sheetName, rowNumber, asin: expectedAsin, note: "SİLİNECEK" };
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
  {
    name: "list_all_costs",
    description: "Product Costs sekmesindeki tum maliyet satirlarini, toplam satir ve benzersiz ASIN sayisiyla listeler.",
    inputSchema: {
      type: "object",
      properties: {
        asin_prefix: { type: "string", description: "Opsiyonel ASIN on eki" },
        date_from: { type: "string", format: "date", description: "Dahil baslangic tarihi (YYYY-MM-DD)" },
        date_to: { type: "string", format: "date", description: "Dahil bitis tarihi (YYYY-MM-DD)" },
      },
    },
  },
  {
    name: "list_all_stocks",
    description: "Product Stock sekmesindeki tum stok satirlarini, toplam satir ve benzersiz ASIN sayisiyla listeler.",
    inputSchema: {
      type: "object",
      properties: {
        asin_prefix: { type: "string", description: "Opsiyonel ASIN on eki" },
        date_from: { type: "string", format: "date", description: "Dahil baslangic tarihi (YYYY-MM-DD)" },
        date_to: { type: "string", format: "date", description: "Dahil bitis tarihi (YYYY-MM-DD)" },
      },
    },
  },
  {
    name: "update_current_values",
    description: "Product Costs ve Product Stock'taki her ASIN'in son kaydini Current Values sekmesine toplu olarak gunceller veya ekler.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add_cost_bulk",
    description: "Birden fazla urun maliyetini tek append istegiyle yeni satirlar olarak ekler.",
    inputSchema: {
      type: "object",
      properties: {
        records: {
          type: "array", minItems: 1, maxItems: 500,
          items: {
            type: "object",
            properties: {
              asin: { type: "string" }, product_name: { type: "string" }, cost: { type: "number" },
              en: { type: "number" }, boy: { type: "number" }, yukseklik: { type: "number" },
              agirlik: { type: "number" }, paket_durumu: { type: "string" },
            },
            required: ["asin", "cost"],
          },
        },
      },
      required: ["records"],
    },
  },
  {
    name: "add_stock_bulk",
    description: "Birden fazla urun stok kaydini tek append istegiyle yeni satirlar olarak ekler.",
    inputSchema: {
      type: "object",
      properties: {
        records: {
          type: "array", minItems: 1, maxItems: 500,
          items: {
            type: "object",
            properties: {
              asin: { type: "string" }, product_name: { type: "string" },
              stock: { type: "number" }, notes: { type: "string" },
            },
            required: ["asin", "stock"],
          },
        },
      },
      required: ["records"],
    },
  },
  {
    name: "find_products",
    description: "ASIN veya urun adinin bir parcasi ile guncel urunleri arar.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "clone_cost",
    description: "Bir ASIN'in son maliyet, isim, olcu, agirlik ve paket bilgilerini hedef ASIN'lere toplu olarak kopyalar.",
    inputSchema: {
      type: "object",
      properties: {
        source_asin: { type: "string" },
        target_asins: { type: "array", minItems: 1, maxItems: 500, items: { type: "string" } },
      },
      required: ["source_asin", "target_asins"],
    },
  },
  {
    name: "get_missing_fields",
    description: "Her ASIN'in son maliyet kaydinda eksik isim, agirlik veya paket durumu alanlarini listeler.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "find_duplicates",
    description: "Ayni ASIN'in farkli isimlerini ve ayni isimle kayitli farkli ASIN'leri satir numaralariyla bulur.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mark_row_deleted",
    description: "Bir maliyet veya stok satirini silmeden, ASIN guvenlik kontrolunden sonra NOT alanina SILINECEK yazar.",
    inputSchema: {
      type: "object",
      properties: {
        sheet: { type: "string", enum: ["cost", "stock"] },
        row_number: { type: "integer", minimum: 2 },
        asin: { type: "string", description: "Satir kaymasina karsi dogrulanacak ASIN" },
      },
      required: ["sheet", "row_number", "asin"],
    },
  },
];
