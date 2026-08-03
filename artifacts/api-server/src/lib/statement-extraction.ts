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
export const RawStatementSchema = z.object({
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  opening_balance: z.string(),
  closing_balance: z.string(),
  transactions: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        description: z.string().min(1).max(500),
        amount: z.string(),
        direction: z.enum(["in", "out"]),
        low_confidence: z.boolean(),
      }),
    )
    .max(3000),
});
export type RawStatement = z.infer<typeof RawStatementSchema>;

export interface StatementExtractor {
  /** Extract structured statement data from a base64 PDF. */
  extract(pdfBase64: string): Promise<RawStatement>;
}

const EXTRACTION_PROMPT = `You are extracting data from a bank statement PDF (it may be a digital PDF or a scan — read the page images carefully).

Return ONLY a JSON object, no prose, no markdown fences, with this exact shape:
{
  "period_start": "YYYY-MM-DD" or null,
  "period_end": "YYYY-MM-DD" or null,
  "opening_balance": "signed decimal string, e.g. \\"1234.56\\" or \\"-50.00\\"",
  "closing_balance": "signed decimal string",
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "string, verbatim from the statement",
      "amount": "POSITIVE decimal string (the magnitude)",
      "direction": "out" for money leaving the account (withdrawals, payments, fees, debits) or "in" for money arriving (deposits, credits),
      "low_confidence": true if you are not fully sure you read this row correctly (blurry scan, ambiguous column), else false
    }
  ]
}

Rules:
- Include EVERY transaction line in the statement period. Do not skip small fees or interest lines.
- opening_balance is the balance BEFORE the first transaction; closing_balance is the balance AFTER the last one.
- Balances may be negative (overdraft) — use a leading minus sign.
- Amounts use "." as the decimal separator and NO thousands separators or currency symbols.
- Do not invent transactions. If a row is unreadable, still include your best reading with "low_confidence": true.
- If the document is not a bank statement, return {"period_start":null,"period_end":null,"opening_balance":"0.00","closing_balance":"0.00","transactions":[]}.`;

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
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
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
    });
    const block = message.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") {
      throw new Error("Model returned no text content.");
    }
    return RawStatementSchema.parse(parseModelJson(block.text));
  }
}

export const statementExtractor: StatementExtractor =
  new AnthropicStatementExtractor();

/**
 * Pure balance-reconciliation math in BigInt minor units.
 * discrepancy = closing − (opening + Σ signed amounts); 0n means balanced.
 */
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
