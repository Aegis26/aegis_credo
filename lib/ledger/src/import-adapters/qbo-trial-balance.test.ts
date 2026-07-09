import { describe, it, expect } from "vitest";
import { parseDecimalToMinor } from "../money";
import {
  parseQboTrialBalance,
  resolveAccountType,
  toImportFileInput,
  TrialBalanceParseError,
} from "./qbo-trial-balance";

/**
 * The real QuickBooks Online "Trial Balance" export shape, as a grid of cells.
 * Preamble rows (company, report title, "As of", blank), a header row, account
 * rows (debit-only and credit-only, some amounts with thousands separators), a
 * section-header row (name only, no amounts), and a TOTAL row — all of which the
 * adapter must handle. Balanced at 26,530.10 on both sides.
 */
const CRAIG_ROWS: string[][] = [
  ["Craig's Design and Landscaping Services", "", ""],
  ["Trial Balance", "", ""],
  ["As of Jul 9, 2026", "", ""],
  ["", "", ""],
  ["Account Name", "Debit", "Credit"],
  ["Checking", "1,201.00", ""],
  ["Savings", "800.00", ""],
  ["Accounts Receivable (A/R)", "5,281.52", ""],
  ["Inventory Asset", "596.25", ""],
  ["Undeposited Funds", "2,062.52", ""],
  ["Truck", "13,495.00", ""],
  ["Expenses", "", ""], // section header: name only, no amounts -> skipped
  ["Job Materials", "1,200.00", ""],
  ["Cost of Goods Sold", "800.00", ""],
  ["Automobile", "350.00", ""],
  ["Insurance", "241.23", ""],
  ["Legal & Professional Fees", "75.00", ""],
  ["Maintenance and Repair", "185.00", ""],
  ["Utilities", "114.09", ""],
  ["Meals and Entertainment", "28.49", ""],
  ["Ask My Accountant", "100.00", ""], // no keyword -> ambiguous
  ["Accounts Payable (A/P)", "", "1,602.67"],
  ["Mastercard", "", "157.72"],
  ["Visa", "", "900.00"],
  ["Board of Equalization Payable", "", "370.94"],
  ["Loan Payable", "", "4,000.00"],
  ["Opening Balance Equity", "", "9,337.50"],
  ["Retained Earnings", "", "3,000.00"],
  ["Design income", "", "2,500.00"],
  ["Landscaping Services", "", "3,161.27"],
  ["Services", "", "1,500.00"],
  ["TOTAL", "26,530.10", "26,530.10"], // must be skipped, never imported
];

describe("parseDecimalToMinor", () => {
  it("parses thousands separators and quoted-style dollars into minor units", () => {
    expect(parseDecimalToMinor("1,201.00")).toBe(120100n);
    expect(parseDecimalToMinor("800.00")).toBe(80000n);
    expect(parseDecimalToMinor("5,281.52")).toBe(528152n);
    expect(parseDecimalToMinor("13,495.00")).toBe(1349500n);
    expect(parseDecimalToMinor("1,000,000.00")).toBe(100000000n);
  });

  it("handles integers, single fraction digit, and zero", () => {
    expect(parseDecimalToMinor("800")).toBe(80000n);
    expect(parseDecimalToMinor("12.5")).toBe(1250n);
    expect(parseDecimalToMinor("0.00")).toBe(0n);
  });

  it("handles signed and parenthesised negatives without floats", () => {
    expect(parseDecimalToMinor("-370.94")).toBe(-37094n);
    expect(parseDecimalToMinor("(370.94)")).toBe(-37094n);
  });

  it("rejects non-numeric and over-precise input", () => {
    expect(() => parseDecimalToMinor("abc")).toThrow(RangeError);
    expect(() => parseDecimalToMinor("1.234")).toThrow(RangeError);
    expect(() => parseDecimalToMinor("")).toThrow(RangeError);
  });
});

describe("resolveAccountType", () => {
  it("maps common QuickBooks account names by keyword", () => {
    expect(resolveAccountType("Checking", "debit").type).toBe("asset");
    expect(resolveAccountType("Accounts Receivable (A/R)", "debit").type).toBe(
      "asset",
    );
    expect(resolveAccountType("Accounts Payable (A/P)", "credit").type).toBe(
      "liability",
    );
    expect(resolveAccountType("Loan Payable", "credit").type).toBe("liability");
    expect(resolveAccountType("Opening Balance Equity", "credit").type).toBe(
      "equity",
    );
    expect(resolveAccountType("Design income", "credit").type).toBe("revenue");
    expect(resolveAccountType("Landscaping Services", "credit").type).toBe(
      "revenue",
    );
    expect(resolveAccountType("Legal & Professional Fees", "debit").type).toBe(
      "expense",
    );
    expect(resolveAccountType("Cost of Goods Sold", "debit").type).toBe(
      "expense",
    );
  });

  it("marks unmapped accounts ambiguous, never silently guessing", () => {
    const debitSide = resolveAccountType("Ask My Accountant", "debit");
    expect(debitSide.typeSource).toBe("ambiguous");
    expect(debitSide.candidateTypes).toEqual(["asset", "expense"]);

    const creditSide = resolveAccountType("Mystery Reserve", "credit");
    expect(creditSide.typeSource).toBe("ambiguous");
    expect(creditSide.candidateTypes).toEqual([
      "liability",
      "equity",
      "revenue",
    ]);
  });
});

describe("parseQboTrialBalance", () => {
  const parse = parseQboTrialBalance(CRAIG_ROWS);

  it("extracts preamble metadata", () => {
    expect(parse.companyName).toBe("Craig's Design and Landscaping Services");
    expect(parse.asOf).toBe("As of Jul 9, 2026");
  });

  it("skips preamble, blank, section-header, and TOTAL rows", () => {
    // 25 real accounts (the header, preamble, blank, 'Expenses' section, and
    // TOTAL rows are all excluded).
    expect(parse.accounts).toHaveLength(25);
    expect(parse.accounts.some((a) => /total/i.test(a.name))).toBe(false);
    expect(parse.accounts.some((a) => a.name === "Expenses")).toBe(false);
  });

  it("parses amounts into integer minor units and balances", () => {
    const checking = parse.accounts.find((a) => a.name === "Checking")!;
    expect(checking.debit).toBe("120100");
    expect(checking.credit).toBe("0");
    const ar = parse.accounts.find((a) =>
      a.name.startsWith("Accounts Receivable"),
    )!;
    expect(ar.debit).toBe("528152");
    expect(parse.totalDebit).toBe("2653010");
    expect(parse.totalCredit).toBe("2653010");
    expect(parse.balanced).toBe(true);
  });

  it("surfaces the ambiguous account for review", () => {
    const ama = parse.accounts.find((a) => a.name === "Ask My Accountant")!;
    expect(ama.typeSource).toBe("ambiguous");
    expect(ama.candidateTypes).toEqual(["asset", "expense"]);
    const mapped = parse.accounts.filter((a) => a.typeSource === "mapped");
    expect(mapped.length).toBe(24);
  });

  it("throws a friendly error when the header is missing", () => {
    expect(() =>
      parseQboTrialBalance([["just", "some", "junk"], ["1", "2", "3"]]),
    ).toThrow(TrialBalanceParseError);
  });

  it("throws a friendly error on an unreadable amount", () => {
    const rows = [
      ["Account Name", "Debit", "Credit"],
      ["Checking", "1.2.3", ""],
    ];
    expect(() => parseQboTrialBalance(rows)).toThrow(TrialBalanceParseError);
  });
});

describe("toImportFileInput", () => {
  it("emits one opening-balance line per account with no plug when balanced", () => {
    const parse = parseQboTrialBalance(CRAIG_ROWS);
    const draft = toImportFileInput(parse);
    expect(draft.source).toBe("quickbooks");
    expect(draft.accounts).toHaveLength(25);
    expect(draft.openingBalances).toHaveLength(25);
    const totalDebit = draft.openingBalances.reduce(
      (s, l) => s + BigInt(l.debit ?? "0"),
      0n,
    );
    const totalCredit = draft.openingBalances.reduce(
      (s, l) => s + BigInt(l.credit ?? "0"),
      0n,
    );
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe(2653010n);
    expect(draft.accounts.some((a) => a.name === "Opening Balance Equity")).toBe(
      true,
    );
  });

  it("applies user type overrides from the review step", () => {
    const parse = parseQboTrialBalance(CRAIG_ROWS);
    const draft = toImportFileInput(parse, { "Ask My Accountant": "expense" });
    const ama = draft.accounts.find((a) => a.name === "Ask My Accountant")!;
    expect(ama.type).toBe("expense");
  });

  it("plugs the difference to Opening Balance Equity when unbalanced", () => {
    const rows = [
      ["Account Name", "Debit", "Credit"],
      ["Checking", "1,000.00", ""],
      ["Sales", "", "600.00"],
    ];
    const parse = parseQboTrialBalance(rows);
    expect(parse.balanced).toBe(false);
    const draft = toImportFileInput(parse);
    const plug = draft.accounts.find((a) => a.name === "Opening Balance Equity");
    expect(plug).toBeDefined();
    const totalDebit = draft.openingBalances.reduce(
      (s, l) => s + BigInt(l.debit ?? "0"),
      0n,
    );
    const totalCredit = draft.openingBalances.reduce(
      (s, l) => s + BigInt(l.credit ?? "0"),
      0n,
    );
    expect(totalDebit).toBe(totalCredit);
    // 1000.00 Dr vs 600.00 Cr -> 400.00 credit plug.
    const plugLine = draft.openingBalances.find(
      (l) => l.accountCode === plug!.code,
    )!;
    expect(plugLine.credit).toBe("40000");
  });
});
