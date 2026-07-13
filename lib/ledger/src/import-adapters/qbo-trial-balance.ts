import type { AccountType } from "@workspace/db";
import { parseDecimalToMinor, type Money } from "../money";

/**
 * ADAPTER — QuickBooks Online "Trial Balance" CSV/XLSX export.
 *
 * This is a thin, ISOLATED translation layer. It reshapes a raw vendor grid
 * (rows of string cells, as produced by a CSV/XLSX reader) into the ledger's
 * canonical import shape. It NEVER touches the database, the posting service, or
 * the reconciliation engine — a broken adapter can only fail to produce a draft,
 * it can never corrupt the ledger. All money is parsed to integer minor units on
 * the proven `parseDecimalToMinor` path; no JS float is ever used.
 */

/** Human-friendly error raised when a grid is not a recognisable QBO export. */
export class TrialBalanceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrialBalanceParseError";
  }
}

/**
 * How an account's type was determined. `mapped` = its own name matched a
 * keyword; `inherited` = its QuickBooks parent (colon hierarchy) resolved and
 * the child takes the parent's type (QBO enforces that sub-accounts share
 * their parent's type); `ambiguous` = surfaced in Review for an explicit
 * choice — NEVER silently defaulted.
 */
export type TypeResolution = "mapped" | "inherited" | "ambiguous";

export interface ResolvedTbAccount {
  /** Deterministic code assigned by the adapter (stable per file). */
  code: string;
  name: string;
  /** Best-guess type. For `ambiguous`, this is a default the user should confirm. */
  type: AccountType;
  typeSource: TypeResolution;
  /** Candidate types to offer in the Review step (only meaningful when ambiguous). */
  candidateTypes: AccountType[];
  /** Integer minor units, as strings, for the canonical import format. */
  debit: string;
  credit: string;
}

export interface QboTrialBalanceParse {
  companyName?: string;
  asOf?: string;
  accounts: ResolvedTbAccount[];
  totalDebit: string; // minor units
  totalCredit: string; // minor units
  balanced: boolean;
}

/** Canonical import body (matches the API's ImportFileInput; `ref` is server-side). */
export interface ImportFileInputDraft {
  source: "quickbooks";
  accounts: { code: string; name: string; type: AccountType }[];
  openingBalances: { accountCode: string; debit?: string; credit?: string }[];
}

const HEADER_ACCOUNT = ["account", "account name", "name"];
const HEADER_DEBIT = "debit";
const HEADER_CREDIT = "credit";

/** Rows we must never import as accounts, matched on the account-name cell. */
const SKIP_NAME = /^(total|subtotal|net (income|loss)|gross profit|net )/i;

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Ordered name-map: the FIRST keyword found in the account name wins, so the
 * list is precedence-ordered — unambiguous phrases first, then explicit
 * expense words (so "Income Tax Expense" is an expense), then revenue words
 * (so "Rental Income" is revenue, not a rental expense), then strong expense
 * indicators like "rental"/"repairs"/"fees" BEFORE generic asset nouns (so
 * "Equipment Rental" is an expense, not equipment). Anything not matched is
 * left `ambiguous` and surfaced to the user rather than silently guessed.
 */
const NAME_MAP: { keyword: string; type: AccountType }[] = [
  // 1. Unambiguous phrases and the receivable/payable families. "payable"
  //    must beat "revenue" ("Arizona Dept. of Revenue Payable" is a liability).
  { keyword: "accounts receivable", type: "asset" },
  { keyword: "a/r", type: "asset" },
  { keyword: "receivable", type: "asset" },
  { keyword: "accounts payable", type: "liability" },
  { keyword: "a/p", type: "liability" },
  { keyword: "payable", type: "liability" },
  { keyword: "sales tax", type: "liability" },
  { keyword: "credit card", type: "liability" },
  { keyword: "undeposited funds", type: "asset" },
  { keyword: "prepaid", type: "asset" },
  { keyword: "inventory", type: "asset" },
  { keyword: "fixed asset", type: "asset" },
  { keyword: "opening balance equity", type: "equity" },
  { keyword: "retained earnings", type: "equity" },
  { keyword: "cost of goods", type: "expense" },
  { keyword: "cogs", type: "expense" },
  // 2. Explicit expense words — before "income" so "Income Tax Expense" wins.
  { keyword: "expenses", type: "expense" },
  { keyword: "expense", type: "expense" },
  // 3. Revenue words — before "rental"/"fees" so "Rental Income" stays revenue.
  { keyword: "income", type: "revenue" },
  { keyword: "revenue", type: "revenue" },
  { keyword: "sales", type: "revenue" },
  // 4. Strong expense indicators — before generic asset nouns so
  //    "Equipment Rental" and "Equipment Repairs" resolve to expense.
  { keyword: "repairs", type: "expense" },
  { keyword: "repair", type: "expense" },
  { keyword: "maintenance", type: "expense" },
  { keyword: "rental", type: "expense" },
  { keyword: "fees", type: "expense" },
  { keyword: "job materials", type: "expense" },
  { keyword: "materials", type: "expense" },
  { keyword: "supplies", type: "expense" },
  { keyword: "rent", type: "expense" },
  { keyword: "utilities", type: "expense" },
  { keyword: "insurance", type: "expense" },
  { keyword: "salaries", type: "expense" },
  { keyword: "wages", type: "expense" },
  { keyword: "payroll", type: "expense" },
  { keyword: "advertising", type: "expense" },
  { keyword: "marketing", type: "expense" },
  { keyword: "meals", type: "expense" },
  { keyword: "entertainment", type: "expense" },
  { keyword: "travel", type: "expense" },
  { keyword: "automobile", type: "expense" },
  { keyword: "fuel", type: "expense" },
  { keyword: "legal", type: "expense" },
  { keyword: "depreciation", type: "expense" },
  // 5. Assets.
  { keyword: "checking", type: "asset" },
  { keyword: "savings", type: "asset" },
  { keyword: "petty cash", type: "asset" },
  { keyword: "cash", type: "asset" },
  { keyword: "bank", type: "asset" },
  { keyword: "truck", type: "asset" },
  { keyword: "vehicle", type: "asset" },
  { keyword: "equipment", type: "asset" },
  { keyword: "furniture", type: "asset" },
  { keyword: "building", type: "asset" },
  { keyword: "land", type: "asset" },
  // 6. Liabilities.
  { keyword: "mastercard", type: "liability" },
  { keyword: "visa", type: "liability" },
  { keyword: "amex", type: "liability" },
  { keyword: "loan", type: "liability" },
  { keyword: "line of credit", type: "liability" },
  // 7. Equity.
  { keyword: "owner", type: "equity" },
  { keyword: "capital", type: "equity" },
  { keyword: "distribution", type: "equity" },
  { keyword: "drawing", type: "equity" },
  { keyword: "equity", type: "equity" },
  // 8. Generic revenue last ("services" appears in many expense phrases).
  { keyword: "services", type: "revenue" },
];

/**
 * Account codes are assigned deterministically by type band + appearance order
 * (asset 10000+, liability 20000+, …), all well clear of the seed chart of
 * accounts (1000–6300). This makes re-importing the SAME export produce the
 * SAME codes, so the frozen importer (which upserts accounts by code) is
 * idempotent. This adapter is designed for the migration workflow it serves:
 * bringing ONE trial balance into a FRESH org. Importing a second, DIFFERENT
 * trial balance into an already-migrated org is out of scope — the frozen
 * engine would post a second opening-balance entry on top of the first
 * (different content hash → not deduplicated), doubling balances and breaking
 * reconciliation regardless of how codes are assigned.
 */
const CODE_BAND: Record<AccountType, number> = {
  asset: 10000,
  liability: 20000,
  equity: 30000,
  revenue: 40000,
  expense: 50000,
};

/** Keyword lookup on a single (flat) name. Returns null when nothing matches. */
function resolveByKeyword(name: string): AccountType | null {
  const lower = norm(name);
  for (const { keyword, type } of NAME_MAP) {
    // Word-boundary match so short keywords never match inside a longer word
    // (e.g. "land" must not match "Landscaping Services").
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(lower)) {
      return type;
    }
  }
  return null;
}

/**
 * Resolve an account type from its name plus the side it sits on in the trial
 * balance.
 *
 * - Colon-delimited names ("Parent:Child") are resolved ROOT-FIRST: QuickBooks
 *   enforces that a sub-account shares its parent's type, so the parent's
 *   resolution wins and the child inherits it ("Maintenance and
 *   Repair:Equipment Repairs" is an expense because its parent is; a
 *   "Landscaping Services:Job Materials" sub-INCOME account stays revenue even
 *   though "materials" alone would read as an expense).
 * - Flat names resolve by keyword (mapped).
 * - "Discount(s)…" accounts are contra-revenue: best-guess `revenue`, but
 *   surfaced as ambiguous so the user must confirm.
 * - Anything else is `ambiguous`: candidates are narrowed by the
 *   normal-balance side (debit → asset/expense, credit →
 *   liability/equity/revenue) and the account is surfaced for an EXPLICIT
 *   choice in Review — never silently defaulted to Asset.
 */
export function resolveAccountType(
  name: string,
  side: "debit" | "credit",
): { type: AccountType; typeSource: TypeResolution; candidateTypes: AccountType[] } {
  const segments = name
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length > 1) {
    // Root-first: the shallowest resolvable ancestor decides the type.
    for (let depth = 1; depth <= segments.length; depth++) {
      const prefix = segments.slice(0, depth).join(":");
      const type = resolveByKeyword(prefix);
      if (type) {
        return {
          type,
          typeSource: depth < segments.length ? "inherited" : "mapped",
          candidateTypes: [type],
        };
      }
    }
  } else {
    const type = resolveByKeyword(name);
    if (type) {
      return { type, typeSource: "mapped", candidateTypes: [type] };
    }
  }

  // Contra-revenue ("Discounts given", "Discounts"): a debit-balance account
  // that belongs on the revenue side. Best guess revenue, but confirm.
  if (/\bdiscounts?\b/.test(norm(name))) {
    return {
      type: "revenue",
      typeSource: "ambiguous",
      candidateTypes: ["revenue", "expense"],
    };
  }

  if (side === "debit") {
    return {
      type: "asset",
      typeSource: "ambiguous",
      candidateTypes: ["asset", "expense"],
    };
  }
  return {
    type: "liability",
    typeSource: "ambiguous",
    candidateTypes: ["liability", "equity", "revenue"],
  };
}

interface HeaderLocation {
  headerRow: number;
  accountCol: number;
  debitCol: number;
  creditCol: number;
}

function findHeader(rows: string[][]): HeaderLocation | null {
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].map(norm);
    const accountCol = cells.findIndex((c) => HEADER_ACCOUNT.includes(c));
    const debitCol = cells.findIndex((c) => c === HEADER_DEBIT);
    const creditCol = cells.findIndex((c) => c === HEADER_CREDIT);
    if (accountCol !== -1 && debitCol !== -1 && creditCol !== -1) {
      return { headerRow: r, accountCol, debitCol, creditCol };
    }
  }
  return null;
}

function findPreamble(
  rows: string[][],
  headerRow: number,
): { companyName?: string; asOf?: string } {
  let companyName: string | undefined;
  let asOf: string | undefined;
  for (let r = 0; r < headerRow; r++) {
    const first = (rows[r][0] ?? "").trim();
    if (!first) continue;
    if (/^as of\b/i.test(first)) {
      asOf = first;
    } else if (!companyName && !/trial balance/i.test(first)) {
      companyName = first;
    }
  }
  return { companyName, asOf };
}

/**
 * Parse a QBO Trial Balance grid into resolved accounts with per-account type
 * resolution and integer-minor-unit amounts. Pure: no I/O, no ledger access.
 */
export function parseQboTrialBalance(rows: string[][]): QboTrialBalanceParse {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new TrialBalanceParseError(
      "We couldn't read this as a QuickBooks Trial Balance export — please upload the CSV or Excel you exported from Reports > Trial Balance.",
    );
  }

  const header = findHeader(rows);
  if (!header) {
    throw new TrialBalanceParseError(
      "We couldn't find the Account/Debit/Credit columns. Please upload the CSV or Excel you exported from Reports > Trial Balance.",
    );
  }

  const { companyName, asOf } = findPreamble(rows, header.headerRow);
  const { accountCol, debitCol, creditCol } = header;

  const accounts: ResolvedTbAccount[] = [];
  const bandNext: Record<AccountType, number> = {
    asset: 0,
    liability: 0,
    equity: 0,
    revenue: 0,
    expense: 0,
  };
  const seen = new Set<string>();
  let totalDebit: Money = 0n;
  let totalCredit: Money = 0n;

  for (let r = header.headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[accountCol] ?? "").trim();
    const debitRaw = (row[debitCol] ?? "").trim();
    const creditRaw = (row[creditCol] ?? "").trim();

    if (!name) continue; // blank / spacer row
    if (SKIP_NAME.test(name)) continue; // TOTAL / subtotal / section summary

    // NOTE: rows with a name but no (or zero) amounts are REAL accounts that
    // happen to carry a zero balance in this trial balance (QuickBooks lists
    // them). They are kept — upserted into the chart of accounts — but
    // excluded from the opening journal entry in `toImportFileInput`.
    let debit: Money = 0n;
    let credit: Money = 0n;
    try {
      debit = debitRaw ? parseDecimalToMinor(debitRaw, `${name} debit`) : 0n;
      credit = creditRaw ? parseDecimalToMinor(creditRaw, `${name} credit`) : 0n;
    } catch {
      throw new TrialBalanceParseError(
        `We couldn't read the amount for "${name}". Amounts should look like 1,201.00 — please re-export from Reports > Trial Balance.`,
      );
    }

    if (seen.has(norm(name))) {
      throw new TrialBalanceParseError(
        `The account "${name}" appears more than once in this file.`,
      );
    }
    seen.add(norm(name));

    const side: "debit" | "credit" = credit > debit ? "credit" : "debit";
    const { type, typeSource, candidateTypes } = resolveAccountType(name, side);
    const code = String(CODE_BAND[type] + bandNext[type]);
    bandNext[type] += 1;

    accounts.push({
      code,
      name,
      type,
      typeSource,
      candidateTypes,
      debit: debit.toString(),
      credit: credit.toString(),
    });
    totalDebit += debit;
    totalCredit += credit;
  }

  if (accounts.length === 0) {
    throw new TrialBalanceParseError(
      "We found the header but no account rows. Please upload a complete Trial Balance export.",
    );
  }

  return {
    companyName,
    asOf,
    accounts,
    totalDebit: totalDebit.toString(),
    totalCredit: totalCredit.toString(),
    balanced: totalDebit === totalCredit,
  };
}

/**
 * Assemble the canonical import body from a parse result. Optional `typeOverrides`
 * (keyed by account name) apply the user's Review-step confirmations. A complete
 * trial balance posts as a single balanced opening-balance entry (one line per
 * account); if the file is unbalanced, the difference is plugged to an
 * "Opening Balance Equity" account so the entry still balances.
 */
export function toImportFileInput(
  parse: QboTrialBalanceParse,
  typeOverrides: Record<string, AccountType> = {},
): ImportFileInputDraft {
  const accounts: ImportFileInputDraft["accounts"] = [];
  const openingBalances: ImportFileInputDraft["openingBalances"] = [];

  for (const acc of parse.accounts) {
    const type = typeOverrides[acc.name] ?? acc.type;
    accounts.push({ code: acc.code, name: acc.name, type });
    // Zero-balance accounts belong in the chart of accounts but contribute
    // nothing to the opening entry — the posting service (correctly) rejects
    // journal lines with no amount, so they must never become lines.
    if (acc.debit === "0" && acc.credit === "0") continue;
    const line: { accountCode: string; debit?: string; credit?: string } = {
      accountCode: acc.code,
    };
    if (acc.debit !== "0") line.debit = acc.debit;
    if (acc.credit !== "0") line.credit = acc.credit;
    openingBalances.push(line);
  }

  const totalDebit = BigInt(parse.totalDebit);
  const totalCredit = BigInt(parse.totalCredit);
  if (totalDebit !== totalCredit) {
    const diff = totalDebit - totalCredit; // >0 means debits exceed credits
    const plug = accounts.find(
      (a) => norm(a.name) === "opening balance equity",
    );
    const plugCode = plug?.code ?? String(CODE_BAND.equity + 9999);
    if (!plug) {
      accounts.push({
        code: plugCode,
        name: "Opening Balance Equity",
        type: "equity",
      });
    }
    if (diff > 0n) {
      openingBalances.push({ accountCode: plugCode, credit: diff.toString() });
    } else {
      openingBalances.push({ accountCode: plugCode, debit: (-diff).toString() });
    }
  }

  return { source: "quickbooks", accounts, openingBalances };
}
