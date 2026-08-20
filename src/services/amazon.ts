import { gunzipSync } from "node:zlib";

const UAE_MARKETPLACE_ID = "A2VIGQ35RCS4UG";
const SP_API_BASE = "https://sellingpartnerapi-eu.amazon.com";
const ADS_API_BASE = "https://advertising-api-eu.amazon.com";
const CURRENCY = "AED";

type JsonRecord = Record<string, unknown>;

export type AmazonProfitabilityJob = {
  marketplace: "AE";
  marketplaceId: string;
  currency: "AED";
  startDate: string;
  endDate: string;
  createdAt: string;
  reports: {
    salesAndTraffic?: string;
    returns?: string;
    storageFees?: string;
    listings?: string;
    settlementReportIds: string[];
    ads?: string;
  };
  sourceErrors: Record<string, string>;
};

export type AmazonCostInput = {
  sku?: string;
  asin?: string;
  cogsPerUnit?: number;
  miscellaneousPerUnit?: number;
};

type ReportStatus = {
  reportId: string;
  reportType?: string;
  processingStatus: string;
  reportDocumentId?: string;
  dataStartTime?: string;
  dataEndTime?: string;
};

function requiredEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`${names.join(" veya ")} Render environment alaninda tanimlanmali.`);
}

function optionalEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function validateDate(raw: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    throw new Error(`${field} YYYY-MM-DD biciminde olmali.`);
  }
  return raw;
}

async function lwaAccessToken() {
  const clientId = requiredEnv("AMAZON_LWA_CLIENT_ID_AE", "AMAZON_LWA_CLIENT_ID_EU", "AMAZON_LWA_CLIENT_ID");
  const clientSecret = requiredEnv(
    "AMAZON_LWA_CLIENT_SECRET_AE",
    "AMAZON_LWA_CLIENT_SECRET_EU",
    "AMAZON_LWA_CLIENT_SECRET",
  );
  const refreshToken = requiredEnv("AMAZON_LWA_REFRESH_TOKEN_AE", "AMAZON_LWA_REFRESH_TOKEN_EU");
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const body = (await response.json()) as { access_token?: string; error_description?: string; error?: string };
  if (!response.ok || !body.access_token) {
    throw new Error(`Amazon LWA token alinamadi (HTTP ${response.status}): ${body.error_description || body.error || "bilinmeyen hata"}`);
  }
  return body.access_token;
}

async function spApi<T>(path: string, init: RequestInit = {}) {
  const token = await lwaAccessToken();
  const response = await fetch(`${SP_API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-amz-access-token": token,
      "user-agent": "BabyShowerProfitabilityMCP/1.0",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // Amazon can return plain text for infrastructure failures.
  }
  if (!response.ok) {
    const detail = typeof body === "object" ? JSON.stringify(body) : String(body);
    throw new Error(`Amazon SP-API HTTP ${response.status}: ${detail.slice(0, 1200)}`);
  }
  return body as T;
}

async function createReport(
  reportType: string,
  startDate: string,
  endDate: string,
  reportOptions?: Record<string, string>,
) {
  const result = await spApi<{ reportId: string }>("/reports/2021-06-30/reports", {
    method: "POST",
    body: JSON.stringify({
      reportType,
      marketplaceIds: [UAE_MARKETPLACE_ID],
      dataStartTime: `${startDate}T00:00:00Z`,
      dataEndTime: `${endDate}T23:59:59Z`,
      ...(reportOptions ? { reportOptions } : {}),
    }),
  });
  return result.reportId;
}

async function safeCreate(
  errors: Record<string, string>,
  key: string,
  reportType: string,
  startDate: string,
  endDate: string,
  options?: Record<string, string>,
) {
  try {
    return await createReport(reportType, startDate, endDate, options);
  } catch (error) {
    errors[key] = error instanceof Error ? error.message : String(error);
    return undefined;
  }
}

async function listSettlementReports(startDate: string, endDate: string) {
  const params = new URLSearchParams({
    reportTypes: "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2",
    processingStatuses: "DONE",
    marketplaceIds: UAE_MARKETPLACE_ID,
    createdSince: `${startDate}T00:00:00Z`,
    createdUntil: `${endDate}T23:59:59Z`,
    pageSize: "100",
  });
  const result = await spApi<{ reports?: Array<{ reportId: string }> }>(
    `/reports/2021-06-30/reports?${params.toString()}`,
  );
  return (result.reports || []).map((report) => report.reportId);
}

async function adsAccessToken() {
  return lwaAccessToken();
}

async function startAdsReport(startDate: string, endDate: string) {
  const profileId = requiredEnv("AMAZON_ADS_PROFILE_ID_AE");
  const clientId = requiredEnv("AMAZON_ADS_CLIENT_ID", "AMAZON_LWA_CLIENT_ID_AE", "AMAZON_LWA_CLIENT_ID_EU");
  const response = await fetch(`${ADS_API_BASE}/reporting/reports`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await adsAccessToken()}`,
      "Amazon-Advertising-API-ClientId": clientId,
      "Amazon-Advertising-API-Scope": profileId,
      "Content-Type": "application/vnd.createasyncreportrequest.v3+json",
      Accept: "application/vnd.createasyncreportresponse.v3+json",
    },
    body: JSON.stringify({
      name: `BSC UAE profitability ${startDate} ${endDate}`,
      startDate,
      endDate,
      configuration: {
        adProduct: "SPONSORED_PRODUCTS",
        groupBy: ["advertiser"],
        columns: [
          "advertisedSku",
          "advertisedAsin",
          "spend",
          "sales7d",
          "unitsSoldClicks7d",
          "impressions",
          "clicks",
        ],
        reportTypeId: "spAdvertisedProduct",
        timeUnit: "SUMMARY",
        format: "GZIP_JSON",
      },
    }),
  });
  const body = (await response.json()) as { reportId?: string; message?: string; details?: unknown };
  if (!response.ok || !body.reportId) {
    throw new Error(`Amazon Ads HTTP ${response.status}: ${body.message || JSON.stringify(body.details || body)}`);
  }
  return body.reportId;
}

export async function startAmazonUaeProfitability(input: {
  startDate: string;
  endDate: string;
  includeAds?: boolean;
}) {
  const startDate = validateDate(input.startDate, "startDate");
  const endDate = validateDate(input.endDate, "endDate");
  if (startDate > endDate) throw new Error("startDate endDate'den sonra olamaz.");
  const dayCount = Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
  if (dayCount > 90) throw new Error("Tek karlilik sorgusu en fazla 90 gun olabilir.");

  const sourceErrors: Record<string, string> = {};
  const [salesAndTraffic, returns, storageFees, listings] = await Promise.all([
    safeCreate(sourceErrors, "salesAndTraffic", "GET_SALES_AND_TRAFFIC_REPORT", startDate, endDate, {
      dateGranularity: "DAY",
      asinGranularity: "CHILD",
    }),
    safeCreate(sourceErrors, "returns", "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA", startDate, endDate),
    safeCreate(sourceErrors, "storageFees", "GET_FBA_STORAGE_FEE_CHARGES_DATA", startDate, endDate),
    safeCreate(sourceErrors, "listings", "GET_MERCHANT_LISTINGS_ALL_DATA", startDate, endDate),
  ]);

  let settlementReportIds: string[] = [];
  try {
    settlementReportIds = await listSettlementReports(startDate, endDate);
  } catch (error) {
    sourceErrors.settlements = error instanceof Error ? error.message : String(error);
  }

  let ads: string | undefined;
  if (input.includeAds !== false) {
    try {
      ads = await startAdsReport(startDate, endDate);
    } catch (error) {
      sourceErrors.ads = error instanceof Error ? error.message : String(error);
    }
  }

  const job: AmazonProfitabilityJob = {
    marketplace: "AE",
    marketplaceId: UAE_MARKETPLACE_ID,
    currency: CURRENCY,
    startDate,
    endDate,
    createdAt: new Date().toISOString(),
    reports: { salesAndTraffic, returns, storageFees, listings, settlementReportIds, ads },
    sourceErrors,
  };
  return {
    ok: true,
    status: "PROCESSING",
    job,
    nextAction:
      "Amazon raporlari asenkron hazirlanir. 30-120 saniye sonra amazon_uae_profitability_get aracini bu job nesnesiyle cagir.",
    warning:
      "Settlement raporlari Amazon tarafindan otomatik olusturulur. Secilen tarih araliginda settlement yoksa gerceklesen Amazon kesintileri eksik kalir.",
  };
}

async function getReportStatus(reportId: string) {
  return spApi<ReportStatus>(`/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`);
}

async function downloadSpReport(status: ReportStatus) {
  if (!status.reportDocumentId) throw new Error(`${status.reportId} icin reportDocumentId yok.`);
  const document = await spApi<{ url: string; compressionAlgorithm?: string }>(
    `/reports/2021-06-30/documents/${encodeURIComponent(status.reportDocumentId)}`,
  );
  const response = await fetch(document.url);
  if (!response.ok) throw new Error(`Amazon rapor dosyasi indirilemedi (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return (document.compressionAlgorithm === "GZIP" ? gunzipSync(bytes) : bytes).toString("utf8");
}

function splitDelimitedLine(line: string, delimiter: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(current);
      current = "";
    } else current += char;
  }
  cells.push(current);
  return cells;
}

function parseDelimited(text: string) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [] as Record<string, string>[];
  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const headers = splitDelimitedLine(lines[0], delimiter).map((header) => header.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const values = splitDelimitedLine(line, delimiter);
    return Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() || ""]));
  });
}

function numberValue(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const normalized = String(value ?? "").replace(/[^0-9.,-]/g, "").replace(/,(?=\d{1,2}$)/, ".");
  const parsed = Number(normalized.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function first(row: Record<string, string>, ...keys: string[]) {
  for (const key of keys) if (row[key]) return row[key];
  return "";
}

function keyOf(sku?: string, asin?: string) {
  return sku ? `sku:${sku}` : asin ? `asin:${asin}` : "unknown";
}

type ProfitRow = {
  sku?: string;
  asin?: string;
  title?: string;
  currency: string;
  unitsSold: number;
  unitsReturned: number;
  netUnitsSold: number;
  sales: number;
  netSales: number;
  referralFee: number;
  fbaFulfillmentFee: number;
  storageFee: number;
  estimatedStorageFee: number;
  otherAmazonCharges: number;
  amazonChargesExcludingAds: number;
  sponsoredProductsCharge: number;
  totalAmazonCharges: number;
  cogs: number | null;
  miscellaneousCost: number | null;
  totalOffAmazonCost: number | null;
  netProceeds: number | null;
  profitMarginPercent: number | null;
  averageSalesPrice: number | null;
};

function emptyRow(sku?: string, asin?: string): ProfitRow {
  return {
    sku,
    asin,
    currency: CURRENCY,
    unitsSold: 0,
    unitsReturned: 0,
    netUnitsSold: 0,
    sales: 0,
    netSales: 0,
    referralFee: 0,
    fbaFulfillmentFee: 0,
    storageFee: 0,
    estimatedStorageFee: 0,
    otherAmazonCharges: 0,
    amazonChargesExcludingAds: 0,
    sponsoredProductsCharge: 0,
    totalAmazonCharges: 0,
    cogs: null,
    miscellaneousCost: null,
    totalOffAmazonCost: null,
    netProceeds: null,
    profitMarginPercent: null,
    averageSalesPrice: null,
  };
}

function round(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function getAdsReport(reportId: string) {
  const profileId = requiredEnv("AMAZON_ADS_PROFILE_ID_AE");
  const clientId = requiredEnv("AMAZON_ADS_CLIENT_ID", "AMAZON_LWA_CLIENT_ID_AE", "AMAZON_LWA_CLIENT_ID_EU");
  const token = await adsAccessToken();
  const response = await fetch(`${ADS_API_BASE}/reporting/reports/${encodeURIComponent(reportId)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Amazon-Advertising-API-ClientId": clientId,
      "Amazon-Advertising-API-Scope": profileId,
      Accept: "application/vnd.getasyncreportresponse.v3+json",
    },
  });
  const body = (await response.json()) as { status?: string; url?: string; failureReason?: string };
  if (!response.ok) throw new Error(`Amazon Ads durum HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function downloadAdsReport(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Amazon Ads raporu indirilemedi (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = gunzipSync(bytes).toString("utf8");
  return JSON.parse(text) as JsonRecord[];
}

export async function getAmazonUaeProfitability(input: {
  job: AmazonProfitabilityJob;
  costs?: AmazonCostInput[];
  page?: number;
  pageSize?: number;
  sortBy?: "netProceeds" | "sales" | "unitsSold" | "amazonCharges" | "adsSpend";
}) {
  const job = input.job;
  if (!job || job.marketplaceId !== UAE_MARKETPLACE_ID || job.currency !== CURRENCY) {
    throw new Error("Gecersiz veya UAE disi profitability job nesnesi.");
  }

  const sourceStatus: Record<string, unknown> = {};
  const documents: Record<string, string[]> = {};
  const pending: string[] = [];
  const failed: Record<string, string> = { ...job.sourceErrors };

  const reportGroups: Array<[string, string[]]> = [
    ["salesAndTraffic", job.reports.salesAndTraffic ? [job.reports.salesAndTraffic] : []],
    ["returns", job.reports.returns ? [job.reports.returns] : []],
    ["storageFees", job.reports.storageFees ? [job.reports.storageFees] : []],
    ["listings", job.reports.listings ? [job.reports.listings] : []],
    ["settlements", job.reports.settlementReportIds || []],
  ];

  for (const [source, reportIds] of reportGroups) {
    documents[source] = [];
    const statuses: ReportStatus[] = [];
    for (const reportId of reportIds) {
      try {
        const status = await getReportStatus(reportId);
        statuses.push(status);
        if (["IN_QUEUE", "IN_PROGRESS"].includes(status.processingStatus)) pending.push(`${source}:${reportId}`);
        else if (status.processingStatus === "DONE" && status.reportDocumentId) {
          documents[source].push(await downloadSpReport(status));
        } else if (status.processingStatus !== "DONE") failed[`${source}:${reportId}`] = status.processingStatus;
      } catch (error) {
        failed[`${source}:${reportId}`] = error instanceof Error ? error.message : String(error);
      }
    }
    sourceStatus[source] = statuses.map((status) => ({
      reportId: status.reportId,
      status: status.processingStatus,
      dataStartTime: status.dataStartTime,
      dataEndTime: status.dataEndTime,
    }));
  }

  let adsRows: JsonRecord[] = [];
  if (job.reports.ads) {
    try {
      const adsStatus = await getAdsReport(job.reports.ads);
      sourceStatus.ads = adsStatus.status;
      if (adsStatus.status === "COMPLETED" && adsStatus.url) adsRows = await downloadAdsReport(adsStatus.url);
      else if (["PENDING", "PROCESSING"].includes(String(adsStatus.status))) pending.push(`ads:${job.reports.ads}`);
      else if (adsStatus.status && adsStatus.status !== "COMPLETED") failed.ads = adsStatus.failureReason || adsStatus.status;
    } catch (error) {
      failed.ads = error instanceof Error ? error.message : String(error);
    }
  }

  if (pending.length) {
    return {
      ok: true,
      status: "PROCESSING",
      pending,
      sourceStatus,
      sourceErrors: failed,
      nextAction: "30-90 saniye sonra ayni job nesnesiyle tekrar cagir.",
    };
  }

  const rows = new Map<string, ProfitRow>();
  const asinToSku = new Map<string, string>();
  const ensure = (sku?: string, asin?: string) => {
    const mappedSku = sku || (asin ? asinToSku.get(asin) : undefined);
    const key = keyOf(mappedSku, asin);
    let row = rows.get(key);
    if (!row) {
      row = emptyRow(mappedSku, asin);
      rows.set(key, row);
    }
    if (asin && !row.asin) row.asin = asin;
    if (mappedSku && !row.sku) row.sku = mappedSku;
    return row;
  };

  for (const document of documents.listings || []) {
    for (const item of parseDelimited(document)) {
      const sku = first(item, "seller-sku", "sku");
      const asin = first(item, "asin1", "asin");
      if (sku && asin) asinToSku.set(asin, sku);
      const row = ensure(sku || undefined, asin || undefined);
      row.title ||= first(item, "item-name", "product-name") || undefined;
    }
  }

  for (const document of documents.salesAndTraffic || []) {
    const report = JSON.parse(document) as {
      salesAndTrafficByAsin?: Array<{
        childAsin?: string;
        salesByAsin?: {
          unitsOrdered?: number;
          unitsRefunded?: number;
          orderedProductSales?: { amount?: number; currencyCode?: string };
        };
      }>;
    };
    for (const item of report.salesAndTrafficByAsin || []) {
      const sales = item.salesByAsin || {};
      const currency = sales.orderedProductSales?.currencyCode || CURRENCY;
      if (currency !== CURRENCY) {
        failed[`currency:${item.childAsin || "unknown"}`] = `${currency} verisi AED toplamlarina katilmadi.`;
        continue;
      }
      const row = ensure(undefined, item.childAsin);
      row.unitsSold += numberValue(sales.unitsOrdered);
      row.sales += numberValue(sales.orderedProductSales?.amount);
      row.netSales += numberValue(sales.orderedProductSales?.amount);
    }
  }

  for (const document of documents.returns || []) {
    for (const item of parseDelimited(document)) {
      const sku = first(item, "sku", "seller-sku");
      const asin = first(item, "asin", "asin1");
      const row = ensure(sku || undefined, asin || undefined);
      row.unitsReturned += numberValue(first(item, "quantity", "return-quantity") || 1);
      row.title ||= first(item, "product-name", "item-name") || undefined;
    }
  }

  for (const document of documents.storageFees || []) {
    for (const item of parseDelimited(document)) {
      const currency = first(item, "currency", "currency-code") || CURRENCY;
      if (currency !== CURRENCY) continue;
      const row = ensure(first(item, "sku", "seller-sku") || undefined, first(item, "asin") || undefined);
      row.estimatedStorageFee += Math.abs(
        numberValue(first(item, "estimated-monthly-storage-fee", "monthly-storage-fee", "storage-fee")),
      );
    }
  }

  let accountLevelAmazonCharges = 0;
  for (const document of documents.settlements || []) {
    for (const item of parseDelimited(document)) {
      const posted = first(item, "posted-date", "posted-date-time").slice(0, 10);
      if (posted && (posted < job.startDate || posted > job.endDate)) continue;
      const currency = first(item, "currency", "currency-code") || CURRENCY;
      if (currency !== CURRENCY) {
        failed[`currency:settlement:${currency}`] = `${currency} settlement satirlari AED toplamlarina katilmadi.`;
        continue;
      }
      const amountType = first(item, "amount-type").toLowerCase();
      const description = first(item, "amount-description").toLowerCase();
      if (!amountType.includes("fee") && !amountType.includes("charge") && !description.includes("fee")) continue;
      const signedAmount = numberValue(first(item, "amount"));
      const charge = -signedAmount;
      const sku = first(item, "sku", "seller-sku") || undefined;
      const asin = first(item, "asin") || undefined;
      if (!sku && !asin) {
        accountLevelAmazonCharges += charge;
        continue;
      }
      const row = ensure(sku, asin);
      if (/referral|commission/.test(description)) row.referralFee += charge;
      else if (/fulfil|fulfill|fba|pick.?pack|weight.handling/.test(description)) row.fbaFulfillmentFee += charge;
      else if (/storage/.test(description)) row.storageFee += charge;
      else row.otherAmazonCharges += charge;
    }
  }

  for (const item of adsRows) {
    const sku = String(item.advertisedSku || item.sku || "");
    const asin = String(item.advertisedAsin || item.asin || "");
    const row = ensure(sku || undefined, asin || undefined);
    row.sponsoredProductsCharge += numberValue(item.spend || item.cost);
  }

  const costs = input.costs || [];
  const costByKey = new Map<string, AmazonCostInput>();
  for (const cost of costs) {
    if (cost.sku) costByKey.set(`sku:${cost.sku}`, cost);
    if (cost.asin) costByKey.set(`asin:${cost.asin}`, cost);
  }

  for (const row of rows.values()) {
    row.unitsReturned = Math.min(row.unitsSold || row.unitsReturned, row.unitsReturned);
    row.netUnitsSold = Math.max(0, row.unitsSold - row.unitsReturned);
    row.referralFee = round(row.referralFee);
    row.fbaFulfillmentFee = round(row.fbaFulfillmentFee);
    row.storageFee = round(row.storageFee);
    row.estimatedStorageFee = round(row.estimatedStorageFee);
    row.otherAmazonCharges = round(row.otherAmazonCharges);
    row.amazonChargesExcludingAds = round(
      row.referralFee + row.fbaFulfillmentFee + row.storageFee + row.otherAmazonCharges,
    );
    row.sponsoredProductsCharge = round(row.sponsoredProductsCharge);
    row.totalAmazonCharges = round(row.amazonChargesExcludingAds + row.sponsoredProductsCharge);
    row.sales = round(row.sales);
    row.netSales = round(row.netSales);
    row.averageSalesPrice = row.unitsSold ? round(row.sales / row.unitsSold) : null;
    const cost = (row.sku && costByKey.get(`sku:${row.sku}`)) || (row.asin && costByKey.get(`asin:${row.asin}`));
    if (cost) {
      row.cogs = round(row.netUnitsSold * numberValue(cost.cogsPerUnit));
      row.miscellaneousCost = round(row.netUnitsSold * numberValue(cost.miscellaneousPerUnit));
      row.totalOffAmazonCost = round(row.cogs + row.miscellaneousCost);
      row.netProceeds = round(row.netSales - row.totalAmazonCharges - row.totalOffAmazonCost);
      row.profitMarginPercent = row.netSales ? round((row.netProceeds / row.netSales) * 100) : null;
    }
  }

  const sortBy = input.sortBy || "netProceeds";
  const metric = (row: ProfitRow) => {
    if (sortBy === "sales") return row.sales;
    if (sortBy === "unitsSold") return row.unitsSold;
    if (sortBy === "amazonCharges") return row.totalAmazonCharges;
    if (sortBy === "adsSpend") return row.sponsoredProductsCharge;
    return row.netProceeds ?? Number.NEGATIVE_INFINITY;
  };
  const allRows = [...rows.values()].filter((row) => row.sku || row.asin).sort((a, b) => metric(b) - metric(a));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(input.pageSize || 25)));
  const page = Math.max(1, Math.trunc(input.page || 1));
  const pagedRows = allRows.slice((page - 1) * pageSize, page * pageSize);
  const completeRows = allRows.filter((row) => row.netProceeds !== null);
  const summary = {
    currency: CURRENCY,
    products: allRows.length,
    productsWithManualCosts: completeRows.length,
    unitsSold: round(allRows.reduce((sum, row) => sum + row.unitsSold, 0)),
    unitsReturned: round(allRows.reduce((sum, row) => sum + row.unitsReturned, 0)),
    netSales: round(allRows.reduce((sum, row) => sum + row.netSales, 0)),
    amazonChargesExcludingAds: round(allRows.reduce((sum, row) => sum + row.amazonChargesExcludingAds, 0)),
    sponsoredProductsCharge: round(allRows.reduce((sum, row) => sum + row.sponsoredProductsCharge, 0)),
    accountLevelAmazonCharges: round(accountLevelAmazonCharges),
    totalAmazonCharges: round(
      allRows.reduce((sum, row) => sum + row.totalAmazonCharges, 0) + accountLevelAmazonCharges,
    ),
    totalOffAmazonCost:
      completeRows.length === allRows.length
        ? round(completeRows.reduce((sum, row) => sum + (row.totalOffAmazonCost || 0), 0))
        : null,
    netProceeds:
      completeRows.length === allRows.length
        ? round(completeRows.reduce((sum, row) => sum + (row.netProceeds || 0), 0))
        : null,
  };

  return {
    ok: true,
    status: "DONE",
    marketplace: "Amazon UAE",
    marketplaceId: UAE_MARKETPLACE_ID,
    dateRange: { startDate: job.startDate, endDate: job.endDate },
    currency: CURRENCY,
    summary,
    pagination: { page, pageSize, totalRows: allRows.length, totalPages: Math.ceil(allRows.length / pageSize) },
    rows: pagedRows,
    sourceStatus,
    sourceErrors: failed,
    sources: {
      sales: "SP-API GET_SALES_AND_TRAFFIC_REPORT",
      returns: "SP-API GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA",
      amazonCharges: "SP-API GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2 (gerceklesen)",
      storage: "SP-API GET_FBA_STORAGE_FEE_CHARGES_DATA",
      ads: "Amazon Ads Reporting v3 spAdvertisedProduct",
      cogsAndMiscellaneous: "Kullanici tarafindan girilen birim maliyetler",
    },
    caveats: [
      "Settlement donemleri secilen tarih araligiyla birebir ortusmeyebilir; satirlar posted-date ile filtrelendi.",
      "estimatedStorageFee tahmindir ve totalAmazonCharges hesabina eklenmez; gerceklesen storageFee settlement kaynagindan gelir.",
      "SKU/ASIN ile eslesmeyen hesap duzeyi kesintiler summary.accountLevelAmazonCharges alaninda tutulur ve urunlere keyfi dagitilmaz.",
      "Iade raporu urun iadesini gosterir; mali iade tutari settlement donemine farkli tarihte yansiyabilir.",
      "COGS veya miscellaneous maliyeti verilmeyen urunlerde netProceeds hesaplanmaz.",
      "Farkli para birimleri AED toplamina katilmaz.",
    ],
  };
}

export function amazonUaeConfigurationStatus() {
  return {
    marketplace: "Amazon UAE",
    marketplaceId: UAE_MARKETPLACE_ID,
    currency: CURRENCY,
    spApiConfigured: Boolean(
      optionalEnv("AMAZON_LWA_CLIENT_ID_AE", "AMAZON_LWA_CLIENT_ID_EU", "AMAZON_LWA_CLIENT_ID") &&
        optionalEnv("AMAZON_LWA_CLIENT_SECRET_AE", "AMAZON_LWA_CLIENT_SECRET_EU", "AMAZON_LWA_CLIENT_SECRET") &&
        optionalEnv("AMAZON_LWA_REFRESH_TOKEN_AE", "AMAZON_LWA_REFRESH_TOKEN_EU"),
    ),
    adsConfigured: Boolean(optionalEnv("AMAZON_ADS_PROFILE_ID_AE")),
    requiredRenderVariables: [
      "AMAZON_LWA_CLIENT_ID_AE (veya EU/common)",
      "AMAZON_LWA_CLIENT_SECRET_AE (veya EU/common)",
      "AMAZON_LWA_REFRESH_TOKEN_AE (veya EU)",
      "AMAZON_ADS_PROFILE_ID_AE (reklam harcamasi icin)",
    ],
    secretsReturned: false,
  };
}
