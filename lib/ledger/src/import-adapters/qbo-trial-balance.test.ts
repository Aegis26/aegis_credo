import { describe, it, expect } from "vitest";
import { parseDecimalToMinor } from "../money";
import {
  parseQboTrialBalance,
  resolveAccountType,
  toImportFileInput,
  TrialBalanceParseError,
} from "./qbo-trial-balance";

/**
 * The real QuickBooks Online "Trial Balance" export shape for the sample
 * company (Craig's Design and Landscaping Services), as a grid of cells:
 * preamble rows, a header row, a flat account list using QBO's colon-delimited
 * parent:child hierarchy, a ZERO-balance account (QuickBooks lists accounts
 * with no balance — "Arizona Dept. of Revenue Payable"), and a TOTAL row.
 * Balanced at 25,553.06 on both sides.
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
  ["Truck:Original Cost", "13,495.00", ""],
  ["Advertising", "74.86", ""],
  ["Automobile:Fuel", "349.41", ""],
  ["Equipment Rental", "112.00", ""],
  ["Insurance", "241.23", ""],
  ["Job Expenses", "155.07", ""],
  ["Job Expenses:Job Materials:Decks and Patios", "234.04", ""],
  ["Legal & Professional Fees", "75.00", ""],
  ["Maintenance and Repair:Equipment Repairs", "185.00", ""],
  ["Meals and Entertainment", "28.49", ""],
  ["Miscellaneous", "100.00", ""],
  ["Office Expenses", "18.08", ""],
  ["Rent or Lease", "240.00", ""],
  ["Utilities:Gas and Electric", "114.09", ""],
  ["Discounts given", "89.50", ""],
  ["Ask My Accountant", "100.00", ""],
  ["Accounts Payable (A/P)", "", "1,602.67"],
  ["Mastercard", "", "157.72"],
  ["Visa", "", "900.00"],
  ["Arizona Dept. of Revenue Payable", "", ""], // ZERO balance — real account
  ["Board of Equalization Payable", "", "370.94"],
  ["Loan Payable", "", "4,000.00"],
  ["Opening Balance Equity", "", "9,337.50"],
  ["Retained Earnings", "", "604.94"],
  ["Design income", "", "2,500.00"],
  ["Landscaping Services", "", "3,161.27"],
  [
    "Landscaping Services:Job Materials:Fountains and Garden Lighting",
    "",
    "1,501.72",
  ],
  ["Sales of Product Income", "", "912.75"],
  ["Services", "", "503.55"],
  ["TOTAL", "25,553.06", "25,553.06"], // must be skipped, never imported
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

  it("types clear expenses as expenses, never Asset (real-file regressions)", () => {
    // "Equipment Rental" is an EXPENSE — "rental" must beat the asset noun
    // "equipment".
    const rental = resolveAccountType("Equipment Rental", "debit");
    expect(rental.type).toBe("expense");
    expect(rental.typeSource).toBe("mapped");
    // "…Expenses" names are expenses.
    expect(resolveAccountType("Office Expenses", "debit").type).toBe("expense");
    expect(resolveAccountType("Job Expenses", "debit").type).toBe("expense");
    // Standalone "Equipment Repairs" (no parent) is still an expense.
    expect(resolveAccountType("Equipment Repairs", "debit").type).toBe(
      "expense",
    );
    expect(resolveAccountType("Rent or Lease", "debit").type).toBe("expense");
  });

  it("keeps revenue/liability words dominant over expense indicators", () => {
    // "Rental Income" is revenue — "income" beats "rental".
    expect(resolveAccountType("Rental Income", "credit").type).toBe("revenue");
    // "Income Tax Expense" is an expense — "expense" beats "income".
    expect(resolveAccountType("Income Tax Expense", "debit").type).toBe(
      "expense",
    );
    // "…Revenue Payable" is a liability — "payable" beats "revenue".
    expect(
      resolveAccountType("Arizona Dept. of Revenue Payable", "credit").type,
    ).toBe("liability");
  });

  it("inherits the type from the QuickBooks parent (colon hierarchy), root-first", () => {
    // Child of an expense parent — even though the child name alone reads
    // asset-ish ("Equipment …").
    const repairs = resolveAccountType(
      "Maintenance and Repair:Equipment Repairs",
      "debit",
    );
    expect(repairs.type).toBe("expense");
    expect(repairs.typeSource).toBe("inherited");
    // Child of a REVENUE parent — "Job Materials" alone would read expense,
    // but QBO sub-accounts share their parent's type.
    const subIncome = resolveAccountType(
      "Landscaping Services:Job Materials:Fountains and Garden Lighting",
      "credit",
    );
    expect(subIncome.type).toBe("revenue");
    expect(subIncome.typeSource).toBe("inherited");
    const fuel = resolveAccountType("Automobile:Fuel", "debit");
    expect(fuel.type).toBe("expense");
    expect(fuel.typeSource).toBe("inherited");
    const truck = resolveAccountType("Truck:Original Cost", "debit");
    expect(truck.type).toBe("asset");
    expect(truck.typeSource).toBe("inherited");
  });

  it("treats Discounts given as contra-revenue and surfaces it for confirmation", () => {
    const discounts = resolveAccountType("Discounts given", "debit");
    expect(discounts.type).toBe("revenue"); // best guess, NOT asset
    expect(discounts.typeSource).toBe("ambiguous"); // must be confirmed
    expect(discounts.candidateTypes).toEqual(["revenue", "expense"]);
  });

  it("marks unmapped accounts ambiguous, never silently guessing", () => {
    const misc = resolveAccountType("Miscellaneous", "debit");
    expect(misc.typeSource).toBe("ambiguous");
    expect(misc.candidateTypes).toEqual(["asset", "expense"]);

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

describe("parseQboTrialBalance (real Craig's file)", () => {
  const parse = parseQboTrialBalance(CRAIG_ROWS);

  it("extracts preamble metadata", () => {
    expect(parse.companyName).toBe("Craig's Design and Landscaping Services");
    expect(parse.asOf).toBe("As of Jul 9, 2026");
  });

  it("keeps every real account (including zero-balance) and skips only TOTAL rows", () => {
    expect(parse.accounts).toHaveLength(34);
    expect(parse.accounts.some((a) => /^total/i.test(a.name))).toBe(false);
  });

  it("keeps zero-balance accounts with a resolved type and zero amounts", () => {
    const az = parse.accounts.find(
      (a) => a.name === "Arizona Dept. of Revenue Payable",
    )!;
    expect(az).toBeDefined();
    expect(az.debit).toBe("0");
    expect(az.credit).toBe("0");
    expect(az.type).toBe("liability"); // "payable" wins over "revenue"
    expect(az.typeSource).toBe("mapped");
  });

  it("parses amounts into integer minor units and balances", () => {
    const checking = parse.accounts.find((a) => a.name === "Checking")!;
    expect(checking.debit).toBe("120100");
    expect(checking.credit).toBe("0");
    const ar = parse.accounts.find((a) =>
      a.name.startsWith("Accounts Receivable"),
    )!;
    expect(ar.debit).toBe("528152");
    expect(parse.totalDebit).toBe("2555306");
    expect(parse.totalCredit).toBe("2555306");
    expect(parse.balanced).toBe(true);
  });

  it("types every clear account correctly — balancing alone is NOT proof", () => {
    const byName = (n: string) =>
      parse.accounts.find((a) => a.name === n)!;
    // The regressions from the real file: all EXPENSES, none of them Asset.
    expect(byName("Equipment Rental").type).toBe("expense");
    expect(byName("Office Expenses").type).toBe("expense");
    expect(byName("Job Expenses").type).toBe("expense");
    expect(byName("Maintenance and Repair:Equipment Repairs").type).toBe(
      "expense",
    );
    expect(byName("Rent or Lease").type).toBe("expense");
    expect(byName("Utilities:Gas and Electric").type).toBe("expense");
    // Sub-income stays revenue despite "Job Materials" in the name.
    expect(
      byName("Landscaping Services:Job Materials:Fountains and Garden Lighting")
        .type,
    ).toBe("revenue");
    expect(byName("Truck:Original Cost").type).toBe("asset");
  });

  it("surfaces exactly the ambiguous accounts for review", () => {
    const ambiguous = parse.accounts.filter(
      (a) => a.typeSource === "ambiguous",
    );
    expect(ambiguous.map((a) => a.name).sort()).toEqual([
      "Ask My Accountant",
      "Discounts given",
      "Miscellaneous",
    ]);
    // Discounts given is surfaced as contra-revenue, not defaulted to Asset.
    const discounts = ambiguous.find((a) => a.name === "Discounts given")!;
    expect(discounts.type).toBe("revenue");
    const inherited = parse.accounts.filter(
      (a) => a.typeSource === "inherited",
    );
    expect(inherited).toHaveLength(6);
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
  it("upserts zero-balance accounts into the COA but emits NO journal line for them", () => {
    const parse = parseQboTrialBalance(CRAIG_ROWS);
    const draft = toImportFileInput(parse);
    expect(draft.source).toBe("quickbooks");
    // All 34 accounts (incl. the zero-balance one) go to the chart of accounts…
    expect(draft.accounts).toHaveLength(34);
    const az = draft.accounts.find(
      (a) => a.name === "Arizona Dept. of Revenue Payable",
    )!;
    expect(az).toBeDefined();
    // …but only the 33 with a balance become opening journal lines.
    expect(draft.openingBalances).toHaveLength(33);
    expect(
      draft.openingBalances.some((l) => l.accountCode === az.code),
    ).toBe(false);
    // Every emitted line has exactly one positive side (the engine's rule).
    for (const line of draft.openingBalances) {
      const hasDebit = line.debit !== undefined && line.debit !== "0";
      const hasCredit = line.credit !== undefined && line.credit !== "0";
      expect(hasDebit !== hasCredit).toBe(true);
    }
    const totalDebit = draft.openingBalances.reduce(
      (s, l) => s + BigInt(l.debit ?? "0"),
      0n,
    );
    const totalCredit = draft.openingBalances.reduce(
      (s, l) => s + BigInt(l.credit ?? "0"),
      0n,
    );
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe(2555306n);
    // The file is balanced, so no plug was added.
    expect(
      draft.accounts.filter((a) => a.name === "Opening Balance Equity"),
    ).toHaveLength(1);
  });

  it("applies user type overrides from the review step", () => {
    const parse = parseQboTrialBalance(CRAIG_ROWS);
    const draft = toImportFileInput(parse, {
      "Ask My Accountant": "expense",
      Miscellaneous: "expense",
      "Discounts given": "revenue",
    });
    expect(
      draft.accounts.find((a) => a.name === "Ask My Accountant")!.type,
    ).toBe("expense");
    expect(draft.accounts.find((a) => a.name === "Miscellaneous")!.type).toBe(
      "expense",
    );
    expect(
      draft.accounts.find((a) => a.name === "Discounts given")!.type,
    ).toBe("revenue");
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
