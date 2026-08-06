/**
 * Bank-statement PDF extraction — provider-isolated.
 *
 * The route only ever talks to the `StatementExtractor` interface; the
 * Anthropic implementation below is the ONLY code that knows which vendor is
 * used. Swapping to a self-managed Anthropic key (or another provider) later
 * is a contained change: implement the interface, change one export.
 *
 * DATA HANDLING (documented for the privacy policy — prototype architecture):
 * - The uploaded PDF is held in memory only and sent base64 to a vision LLM
 *   via Replit's AI Integrations proxy (Anthropic-compatible). It is NEVER
 *   written to disk and NEVER logged (routes log only method/URL/status).
 * - Retention/usage on the AI path is governed by Replit AI Integrations and
 *   Anthropic's API terms (Anthropic's commercial API does not train on API
 *   data by default). Before real customer data flows through this, revisit
 *   running extraction on our own Anthropic key for cost visibility, model
 *   control, and portability off Replit — see replit.md.
 *
 * SAFETY: the model's output is UNTRUSTED. It is parsed as strict JSON,
 * validated with Zod, and every amount goes through `parseMoney` to BigInt
 * minor units. Nothing from the model is executed or posted — the caller
 * returns a dry-run preview that a human must review and confirm.
 */
import { z } from "zod";

/** Raw, validated (but not yet money-parsed) model output. */
const RawTxnSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().min(1).max(500),
  amount: z.string(),
  direction: z.enum(["in", "out"]),
  // The printed running balance after this row, when the statement shows one.
  running_balance: z.string().nullable(),
  low_confidence: z.boolean(),
});

export const RawStatementSchema = z.object({
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  // The statement's stated COMBINED ending balance across all accounts, when
  // it prints one (multi-account statements usually do).
  statement_total_ending_balance: z.string().nullable(),
  accounts: z
    .array(
      z.object({
        account_name: z.string().min(1).max(200),
        account_number_last4: z.string().max(20).nullable(),
        opening_balance: z.string(),
        closing_balance: z.string(),
        transactions: z.array(RawTxnSchema).max(3000),
      }),
    )
    .min(1)
    .max(20),
});
export type RawStatement = z.infer<typeof RawStatementSchema>;
export type RawTxn = z.infer<typeof RawTxnSchema>;

export interface StatementExtractor {
  /** Extract structured statement data from a base64 PDF. */
  extract(pdfBase64: string): Promise<RawStatement>;
}

/**
 * Typed extraction failure so the route can (a) show the user a SPECIFIC,
 * actionable message per cause and (b) log the class/status/stop_reason for
 * diagnosability — WITHOUT ever logging PDF content or model output.
 */
export type ExtractionFailureKind =
  | "too_long" // model output truncated at max_tokens — statement too long for one pass
  | "rate_limited" // provider 429
  | "service" // provider 5xx/overloaded/network
  | "unreadable"; // response was not valid JSON / failed schema validation

export class StatementExtractionError extends Error {
  readonly name = "StatementExtractionError";
  constructor(
    readonly kind: ExtractionFailureKind,
    /** Safe-to-log metadata only. NEVER put document or model content here. */
    readonly meta: {
      errorClass?: string;
      status?: number;
      stopReason?: string;
    } = {},
  ) {
    super(`statement extraction failed: ${kind}`);
  }
}

const EXTRACTION_PROMPT = `You are extracting data from a bank statement PDF (it may be a digital PDF or a scan — read the page images carefully). Statements often contain MULTIPLE accounts (e.g. a checking account and one or more savings accounts) — extract EVERY account separately.

Return ONLY a JSON object, no prose, no markdown fences, with this exact shape:
{
  "period_start": "YYYY-MM-DD" or null,
  "period_end": "YYYY-MM-DD" or null,
  "statement_total_ending_balance": "signed decimal string" or null — the statement's stated COMBINED/total ending balance across all accounts, only if the statement prints one,
  "accounts": [
    {
      "account_name": "the account's name/title as printed (e.g. \\"360 Checking\\", \\"Simply Checking\\")",
      "account_number_last4": "last 4 digits of the account number as printed" or null,
      "opening_balance": "signed decimal string, e.g. \\"1234.56\\" or \\"-50.00\\"",
      "closing_balance": "signed decimal string",
      "transactions": [
        {
          "date": "YYYY-MM-DD",
          "description": "string, verbatim from the statement",
          "amount": "POSITIVE decimal string (the magnitude)",
          "direction": "out" for money leaving this account (withdrawals, payments, fees, debits) or "in" for money arriving (deposits, credits),
          "running_balance": "signed decimal string — the balance column printed on this row, AFTER this transaction" or null if the statement shows no per-row balance,
          "low_confidence": true if you are not fully sure you read this row correctly (blurry scan, ambiguous column), else false
        }
      ]
    }
  ]
}

Rules:
- One entry in "accounts" per account section on the statement, in the order printed. Never merge accounts.
- Include EVERY transaction line with a monetary amount. Do not skip small fees or interest lines.
- SKIP purely informational rows that have NO amount (e.g. "Interest Rate Change from 3.154% to 3.057%"). Never emit them as 0.00 transactions.
- opening_balance is the balance BEFORE the account's first transaction; closing_balance is the balance AFTER its last one.
- Balances may be negative (overdraft) — use a leading minus sign.
- Amounts use "." as the decimal separator and NO thousands separators or currency symbols.
- Do not invent transactions. If a row is unreadable, still include your best reading with "low_confidence": true.
- If the document is not a bank statement, return {"period_start":null,"period_end":null,"statement_total_ending_balance":null,"accounts":[]} — but note the schema requires at least one account for real statements.`;

/** Strip accidental markdown fences and parse strict JSON. */
export function parseModelJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

/** Anthropic (via Replit AI Integrations proxy) — the current prototype provider. */
class AnthropicStatementExtractor implements StatementExtractor {
  async extract(pdfBase64: string): Promise<RawStatement> {
    // Lazy import so the module (and its env-var assertions) only load when
    // the feature is actually used.
    const { anthropic } = await import("@workspace/integrations-anthropic-ai");
    let message;
    try {
      // Long statements need lots of output tokens; 8192 truncated real
      // statements mid-JSON. 32k covers ~1500+ transaction rows. The SDK
      // requires streaming for outputs this large (its non-streaming guard
      // throws upfront), so stream and take the final assembled message.
      message = await anthropic.messages
        .stream({
          model: "claude-sonnet-4-6",
          max_tokens: 32000,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: pdfBase64,
                  },
                },
                { type: "text", text: EXTRACTION_PROMPT },
              ],
            },
          ],
        })
        .finalMessage();
    } catch (err) {
      // Provider errors (Anthropic SDK APIError has a numeric `status`;
      // duck-typed so this file stays provider-agnostic in shape).
      const status =
        err && typeof err === "object" && "status" in err
          ? Number((err as { status: unknown }).status)
          : undefined;
      const meta = {
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
        status: Number.isFinite(status) ? status : undefined,
      };
      throw new StatementExtractionError(
        status === 429 ? "rate_limited" : "service",
        meta,
      );
    }

    if (message.stop_reason === "max_tokens") {
      // Output truncated — the JSON is cut off mid-stream; don't even try.
      throw new StatementExtractionError("too_long", {
        stopReason: message.stop_reason,
      });
    }

    const block = message.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") {
      throw new StatementExtractionError("unreadable", {
        stopReason: message.stop_reason ?? undefined,
      });
    }
    try {
      return RawStatementSchema.parse(parseModelJson(block.text));
    } catch (err) {
      throw new StatementExtractionError("unreadable", {
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
        stopReason: message.stop_reason ?? undefined,
      });
    }
  }
}

export const statementExtractor: StatementExtractor =
  new AnthropicStatementExtractor();

/**
 * Pure balance-reconciliation math in BigInt minor units.
 * discrepancy = closing − (opening + Σ signed amounts); 0n means balanced.
 */
/**
 * Detect likely INTERNAL TRANSFERS between accounts on the same statement:
 * a money-out leg in one account paired with a money-in leg in another with
 * the same magnitude, dates within one day, and at least one description
 * referencing the other account (name words or last4). Greedy 1:1 pairing.
 *
 * v1 policy: detect and FLAG only — both legs stay in the import for the
 * human to confirm or exclude. Nothing is auto-posted as a transfer.
 *
 * Input rows are (accountIndex, txnIndex, signedMinor, date, description);
 * returns a map "acct:txn" → transfer group id shared by both legs.
 */
export function detectInternalTransfers(
  accounts: {
    accountName: string;
    accountNumberLast4: string | null;
    transactions: { date: string; description: string; signedMinor: bigint }[];
  }[],
): Map<string, string> {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  // Tokens that identify an account (drop generic words so "Checking" alone
  // doesn't match every account named "... Checking").
  const GENERIC = new Set([
    "ACCOUNT",
    "BANK",
    "THE",
    "AND",
    "OF",
    // Product-type words appear in most account names ("360 Checking",
    // "Performance Savings") — matching on them alone breeds false positives.
    "CHECKING",
    "SAVINGS",
    "SAVING",
    "MONEY",
    "MARKET",
  ]);
  const accountTokens = accounts.map((a) => {
    const tokens = new Set(
      norm(a.accountName)
        .split(" ")
        .filter((w) => w.length >= 3 && !GENERIC.has(w)),
    );
    if (a.accountNumberLast4) tokens.add(a.accountNumberLast4);
    return tokens;
  });

  const dayDiff = (a: string, b: string) =>
    Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

  const referencesAccount = (description: string, accountIdx: number) => {
    const d = norm(description);
    for (const token of accountTokens[accountIdx]) {
      if (d.includes(token)) return true;
    }
    return false;
  };

  const groups = new Map<string, string>();
  let groupSeq = 0;

  for (let a = 0; a < accounts.length; a++) {
    for (let i = 0; i < accounts[a].transactions.length; i++) {
      const out = accounts[a].transactions[i];
      if (out.signedMinor >= 0n || groups.has(`${a}:${i}`)) continue;
      // Find an unclaimed matching in-leg in ANOTHER account.
      for (let b = 0; b < accounts.length && !groups.has(`${a}:${i}`); b++) {
        if (b === a) continue;
        for (let j = 0; j < accounts[b].transactions.length; j++) {
          const inn = accounts[b].transactions[j];
          if (groups.has(`${b}:${j}`)) continue;
          if (inn.signedMinor <= 0n) continue;
          if (inn.signedMinor !== -out.signedMinor) continue;
          if (dayDiff(out.date, inn.date) > 1) continue;
          // At least one leg's description must reference the other account.
          if (
            !referencesAccount(out.description, b) &&
            !referencesAccount(inn.description, a)
          ) {
            continue;
          }
          const id = `transfer-${++groupSeq}`;
          groups.set(`${a}:${i}`, id);
          groups.set(`${b}:${j}`, id);
          break;
        }
      }
    }
  }
  return groups;
}

/**
 * Running-balance integrity: walk one account's rows in statement order and
 * flag rows whose printed running balance does not equal
 * (previous balance ± amount). Rows without a printed balance advance the
 * expected balance without checking; a mismatched row is flagged and the
 * chain RESYNCS to the printed value so one misread doesn't flag the rest.
 */
export function checkRunningBalances(
  openingMinor: bigint,
  rows: { signedMinor: bigint; runningMinor: bigint | null }[],
): boolean[] {
  const flags: boolean[] = [];
  let expected = openingMinor;
  for (const row of rows) {
    expected += row.signedMinor;
    if (row.runningMinor == null) {
      flags.push(false);
    } else if (row.runningMinor === expected) {
      flags.push(false);
    } else {
      flags.push(true);
      expected = row.runningMinor; // resync
    }
  }
  return flags;
}

export function reconcileStatement(
  openingMinor: bigint,
  closingMinor: bigint,
  signedAmountsMinor: bigint[],
): { computedClosingMinor: bigint; discrepancyMinor: bigint; balanced: boolean } {
  let sum = 0n;
  for (const a of signedAmountsMinor) sum += a;
  const computedClosingMinor = openingMinor + sum;
  const discrepancyMinor = closingMinor - computedClosingMinor;
  return {
    computedClosingMinor,
    discrepancyMinor,
    balanced: discrepancyMinor === 0n,
  };
}
