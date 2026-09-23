import assert from "node:assert/strict";
import test from "node:test";
import {
  formatSheetTimestamp,
  normalizeSheetHeader,
  resolveHeaderIndexes,
  sheetDateKey,
  sheetsTools,
} from "../dist/services/sheets.js";

test("normalizes Turkish headers and resolves reordered columns", () => {
  const headers = [" NOT ", "ağırlık", "AsIn", " İSİM ", "COST(USD)"];
  assert.equal(normalizeSheetHeader(" YÜKSEKLİK "), "yukseklik");
  assert.deepEqual(
    resolveHeaderIndexes("Test", headers, {
      asin: ["ASIN"],
      productName: ["ISIM"],
      cost: ["cost(usd)"],
      notes: ["not"],
    }),
    { asin: 2, productName: 3, cost: 4, notes: 0 },
  );
});

test("fails when a required header is missing", () => {
  assert.throws(
    () => resolveHeaderIndexes("Product Costs", ["ASIN"], { cost: ["COST(USD)"] }),
    /gerekli baslik bulunamadi/,
  );
});

test("normalizes supported sheet dates for inclusive filtering", () => {
  assert.equal(sheetDateKey("23.09.2026 15:21:55"), "2026-09-23");
  assert.equal(sheetDateKey("9/23/2026 15:21:55"), "2026-09-23");
  assert.equal(sheetDateKey("2026-09-03T10:00:00Z"), "2026-09-03");
  assert.equal(sheetDateKey(""), null);
});

test("formats MCP timestamps like Google Form timestamps", () => {
  assert.equal(formatSheetTimestamp(new Date("2026-09-23T12:24:16Z")), "9/23/2026 15:24:16");
});

test("registers all requested Sheets tools", () => {
  const names = new Set(sheetsTools.map((tool) => tool.name));
  for (const name of [
    "list_all_costs",
    "list_all_stocks",
    "update_current_values",
    "add_cost_bulk",
    "add_stock_bulk",
    "find_products",
    "clone_cost",
    "get_missing_fields",
    "find_duplicates",
    "mark_row_deleted",
  ]) {
    assert.ok(names.has(name), `${name} is not registered`);
  }
});
