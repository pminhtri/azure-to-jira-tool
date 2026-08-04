import assert from "node:assert/strict";
import { detectDateOrder, parseCsv, parseCsvDate, parseIdentity } from "./csv.ts";

/* ── Parser ──────────────────────────────────────────────────────────────── */

Deno.test("parseCsv handles quotes, commas and newlines inside fields", () => {
  const rows = parseCsv('a,b,c\n"has, comma","has ""quotes""","line 1\nline 2"\n');
  assert.deepEqual(rows[0], ["a", "b", "c"]);
  assert.deepEqual(rows[1], ["has, comma", 'has "quotes"', "line 1\nline 2"]);
});

Deno.test("parseCsv strips the BOM and accepts CRLF", () => {
  const rows = parseCsv("﻿ID,Title\r\n760,Hello\r\n");
  assert.deepEqual(rows[0], ["ID", "Title"]);
  assert.deepEqual(rows[1], ["760", "Hello"]);
});

Deno.test("parseCsv keeps empty fields in position", () => {
  const rows = parseCsv("a,b,c\n1,,3\n,,\n");
  assert.deepEqual(rows[1], ["1", "", "3"]);
  assert.deepEqual(rows[2], ["", "", ""]);
});

Deno.test("parseCsv accepts a final line without a newline", () => {
  const rows = parseCsv("a,b\n1,2");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ["1", "2"]);
});

/* ── Identity ────────────────────────────────────────────────────────────── */

Deno.test("parseIdentity splits name and email", () => {
  assert.deepEqual(parseIdentity("Leroy Bakker <leroy.bakker@sioux.eu>"), {
    displayName: "Leroy Bakker",
    uniqueName: "leroy.bakker@sioux.eu",
  });
  // Multi-part names with diacritics.
  assert.deepEqual(parseIdentity("Vahid Rosoukhi Sefidanjadid <VAHID.ROSOUKHI@sioux.eu>"), {
    displayName: "Vahid Rosoukhi Sefidanjadid",
    uniqueName: "vahid.rosoukhi@sioux.eu",
  });
});

Deno.test("parseIdentity handles email-only and name-only values", () => {
  assert.deepEqual(parseIdentity("a@b.com"), { displayName: "a@b.com", uniqueName: "a@b.com" });
  assert.deepEqual(parseIdentity("Name Without Email"), { displayName: "Name Without Email" });
  assert.equal(parseIdentity(""), undefined);
  assert.equal(parseIdentity("   "), undefined);
});

/* ── Dates ────────────────────────────────────────────────────────────────── */

Deno.test("detectDateOrder infers month-first when position 2 exceeds 12", () => {
  const r = detectDateOrder(["3/4/2026 6:55:03 PM", "7/28/2026 3:04:39 PM"]);
  assert.equal(r.order, "month-first");
  assert.equal(r.confident, true);
});

Deno.test("detectDateOrder infers day-first when position 1 exceeds 12", () => {
  const r = detectDateOrder(["28/7/2026 15:04:39", "4/3/2026 18:55:03"]);
  assert.equal(r.order, "day-first");
  assert.equal(r.confident, true);
});

Deno.test("detectDateOrder reports low confidence when every value is <= 12", () => {
  const r = detectDateOrder(["3/4/2026", "5/6/2026"]);
  assert.equal(r.confident, false);
  assert.equal(r.order, "month-first");
});

Deno.test("parseCsvDate understands 12-hour AM/PM times", () => {
  assert.equal(parseCsvDate("3/4/2026 6:55:03 PM", "month-first"), "2026-03-04T18:55:03.000Z");
  assert.equal(parseCsvDate("3/4/2026 6:55:03 AM", "month-first"), "2026-03-04T06:55:03.000Z");
  // 12 AM is midnight, 12 PM is noon.
  assert.equal(parseCsvDate("1/1/2026 12:00:00 AM", "month-first"), "2026-01-01T00:00:00.000Z");
  assert.equal(parseCsvDate("1/1/2026 12:00:00 PM", "month-first"), "2026-01-01T12:00:00.000Z");
});

Deno.test("parseCsvDate respects the day/month order", () => {
  assert.equal(parseCsvDate("3/4/2026", "month-first")!.slice(0, 10), "2026-03-04");
  assert.equal(parseCsvDate("3/4/2026", "day-first")!.slice(0, 10), "2026-04-03");
});

Deno.test("parseCsvDate handles invalid values and ISO input", () => {
  assert.equal(parseCsvDate("", "month-first"), null);
  assert.equal(parseCsvDate("not a date", "month-first"), null);
  assert.equal(parseCsvDate("13/45/2026", "month-first"), null);
  assert.equal(parseCsvDate("2026-03-04T18:55:03Z", "month-first"), "2026-03-04T18:55:03.000Z");
});

Deno.test("parseCsvDate with no time part uses UTC midnight", () => {
  assert.equal(parseCsvDate("6/15/2026", "month-first"), "2026-06-15T00:00:00.000Z");
});
