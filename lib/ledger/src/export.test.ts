import { describe, it, expect } from "vitest";
import { toCsv, toSpreadsheetXml, formatMoney, type Sheet } from "./export";

describe("CSV formula-injection sanitization", () => {
  it("neutralizes a =HYPERLINK(...) account name with a leading single quote", () => {
    const sheet: Sheet = {
      name: "TB",
      columns: ["Account", "Balance"],
      rows: [['=HYPERLINK("http://evil.example","click")', "100.00"]],
    };
    const csv = toCsv(sheet);
    const dataLine = csv.split("\r\n")[1];
    expect(dataLine.startsWith(`"'=HYPERLINK(`)).toBe(true);
    expect(dataLine).not.toMatch(/^"?=/);
  });

  it("neutralizes leading +, @, tab, and CR string cells", () => {
    const sheet: Sheet = {
      name: "S",
      columns: ["Memo"],
      rows: [["+1-800-555-0100"], ["@SUM(A1)"], ["\tcmd"], ["\rcmd"]],
    };
    const lines = toCsv(sheet).split("\r\n");
    expect(lines[1]).toBe("'+1-800-555-0100");
    expect(lines[2]).toBe("'@SUM(A1)");
    expect(lines[3].startsWith("'")).toBe(true);
    expect(lines[4].startsWith(`"'`)).toBe(true); // CR also forces quoting
  });

  it("leaves negative money strings EXACTLY unchanged (-123.45)", () => {
    const sheet: Sheet = {
      name: "S",
      columns: ["Amount"],
      rows: [["-123.45"], ["-0.01"], ["0.00"], ["1234.56"]],
    };
    const lines = toCsv(sheet).split("\r\n");
    expect(lines[1]).toBe("-123.45");
    expect(lines[2]).toBe("-0.01");
    expect(lines[3]).toBe("0.00");
    expect(lines[4]).toBe("1234.56");
  });

  it("formatMoney output round-trips through toCsv untouched", () => {
    const values = [-12345n, -1n, 0n, 99n, 1234567n];
    const sheet: Sheet = {
      name: "S",
      columns: ["Amount"],
      rows: values.map((v) => [formatMoney(v)]),
    };
    const lines = toCsv(sheet).split("\r\n").slice(1);
    expect(lines).toEqual(values.map((v) => formatMoney(v)));
  });

  it("numeric and bigint cells bypass sanitization entirely", () => {
    const sheet: Sheet = {
      name: "S",
      columns: ["N", "B"],
      rows: [[-42, -12345n]],
    };
    expect(toCsv(sheet).split("\r\n")[1]).toBe("-42,-12345");
  });

  it("neutralizes a dangerous leading - that is NOT a plain number", () => {
    const sheet: Sheet = {
      name: "S",
      columns: ["Memo"],
      rows: [["-2+3+cmd|' /C calc'!A0"]],
    };
    const line = toCsv(sheet).split("\r\n")[1];
    // No comma/double-quote in the cell, so RFC-4180 leaves it unquoted; the
    // neutralizing apostrophe is prepended directly.
    expect(line.startsWith("'-2+3")).toBe(true);
  });

  it("SpreadsheetML keeps formula-looking strings as typed String cells (already safe)", () => {
    const xml = toSpreadsheetXml({
      sheets: [
        {
          name: "S",
          columns: ["Account"],
          rows: [["=HYPERLINK(1)"]],
        },
      ],
    });
    expect(xml).toContain('<Data ss:Type="String">=HYPERLINK(1)</Data>');
  });
});
