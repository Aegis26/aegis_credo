import { useRef, useState } from "react";
import {
  useExtractBankStatement,
  useConfirmBankStatement,
  getGetBankStatusQueryKey,
  getListBankTransactionsQueryKey,
  getApiErrorMessage,
} from "@workspace/api-client-react";
import type { BankStatementExtraction } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Spinner } from "@/components/ui/spinner";
import { FileText, AlertTriangle, CheckCircle, Trash2, Plus, Upload } from "lucide-react";
import { Link } from "wouter";

interface EditableTxn {
  date: string;
  description: string;
  amount: string; // signed decimal string, negative = money out
  lowConfidence: boolean;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Parse a signed decimal string to integer cents; null when invalid. */
function toCents(s: string): bigint | null {
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) return null;
  const sign = m[1] ? -1n : 1n;
  return sign * (BigInt(m[2]) * 100n + BigInt((m[3] ?? "").padEnd(2, "0")));
}

function fromCents(c: bigint): string {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  return `${neg ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export function StatementImport({ orgId }: { orgId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [extraction, setExtraction] = useState<BankStatementExtraction | null>(null);
  const [txns, setTxns] = useState<EditableTxn[]>([]);
  const [done, setDone] = useState<{ inserted: number; skippedDuplicates: number } | null>(null);

  const extract = useExtractBankStatement();
  const confirm = useConfirmBankStatement();

  const onFile = async (file: File) => {
    setDone(null);
    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
      toast({ variant: "destructive", title: "Not a PDF", description: "Please upload the PDF statement from your bank." });
      return;
    }
    try {
      const result = await extract.mutateAsync({
        orgId,
        data: { content: await readAsBase64(file), filename: file.name },
      });
      setExtraction(result);
      setTxns(result.transactions.map((t) => ({ ...t })));
    } catch (e: unknown) {
      const msg = getApiErrorMessage(e, "We couldn't read this statement. Please try again.");
      toast({ variant: "destructive", title: "Extraction failed", description: msg });
    }
  };

  // Live balance check recomputed as the user edits (integer cents, no floats).
  const opening = extraction ? toCents(extraction.openingBalance) : null;
  const closing = extraction ? toCents(extraction.closingBalance) : null;
  let computed: bigint | null = null;
  let invalidRows = 0;
  if (opening != null) {
    computed = opening;
    for (const t of txns) {
      const c = toCents(t.amount);
      if (c == null) invalidRows++;
      else computed += c;
    }
  }
  const discrepancy = computed != null && closing != null ? closing - computed : null;
  const balanced = discrepancy === 0n && invalidRows === 0;

  const onConfirm = async () => {
    try {
      const result = await confirm.mutateAsync({
        orgId,
        data: {
          transactions: txns.map((t) => ({
            date: t.date,
            description: t.description,
            amount: t.amount.trim(),
          })),
        },
      });
      setDone(result);
      setExtraction(null);
      setTxns([]);
      queryClient.invalidateQueries({ queryKey: getGetBankStatusQueryKey(orgId) });
      queryClient.invalidateQueries({ queryKey: getListBankTransactionsQueryKey(orgId) });
    } catch (e: unknown) {
      const msg = getApiErrorMessage(e, "Import failed. Please check the rows and try again.");
      toast({ variant: "destructive", title: "Import failed", description: msg });
    }
  };

  const update = (i: number, patch: Partial<EditableTxn>) =>
    setTxns((prev) => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  return (
    <Card className="shadow-none border-border bg-card" data-testid="card-statement-import">
      <CardHeader className="border-b border-border bg-accent/30 pb-4">
        <div className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-primary" />
          <CardTitle>Import Statement (PDF)</CardTitle>
        </div>
        <CardDescription>
          No bank connection? Upload a PDF statement — transactions land in Reconcile for your
          review, exactly like a bank feed.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6 space-y-4">
        {done && (
          <Alert className="bg-accent/20 border-border" data-testid="alert-import-done">
            <CheckCircle className="h-4 w-4 text-primary" />
            <AlertTitle>Statement imported</AlertTitle>
            <AlertDescription>
              {done.inserted} transaction{done.inserted === 1 ? "" : "s"} added
              {done.skippedDuplicates > 0 && `, ${done.skippedDuplicates} already imported (skipped)`}.{" "}
              <Link href="/reconcile" className="underline text-primary">
                Categorize them in Reconcile
              </Link>
              .
            </AlertDescription>
          </Alert>
        )}

        {!extraction && (
          <div
            className="text-center py-10 px-4 bg-accent/20 rounded-md border border-border border-dashed cursor-pointer"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) void onFile(f);
            }}
            data-testid="drop-statement"
          >
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,application/pdf"
              className="hidden"
              data-testid="input-statement-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
                e.target.value = "";
              }}
            />
            {extract.isPending ? (
              <div className="flex flex-col items-center gap-3">
                <Spinner className="w-8 h-8 text-primary" />
                <p className="text-sm text-muted-foreground">
                  Reading your statement… this can take up to a minute for scanned documents.
                </p>
              </div>
            ) : (
              <>
                <Upload className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-40" />
                <p className="font-medium text-foreground">Drop your bank statement here</p>
                <p className="text-sm text-muted-foreground mt-1">
                  PDF only, up to 10 MB. Works with scanned statements too. Nothing is posted
                  without your review.
                </p>
              </>
            )}
          </div>
        )}

        {extraction && (
          <div className="space-y-4" data-testid="section-statement-review">
            {balanced ? (
              <Alert className="border-[#3CB54A]/40 bg-[#3CB54A]/10" data-testid="alert-balanced">
                <CheckCircle className="h-4 w-4 text-[#3CB54A]" />
                <AlertTitle>Balanced ✓</AlertTitle>
                <AlertDescription>
                  Opening balance {extraction.openingBalance} plus all transactions equals the
                  closing balance {extraction.closingBalance}.
                </AlertDescription>
              </Alert>
            ) : (
              <Alert variant="destructive" className="bg-destructive/10 border-destructive/40" data-testid="alert-discrepancy">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Doesn't balance — review carefully</AlertTitle>
                <AlertDescription>
                  {invalidRows > 0
                    ? `${invalidRows} row(s) have an invalid amount. `
                    : ""}
                  Opening {extraction.openingBalance} + transactions ={" "}
                  {computed != null ? fromCents(computed) : "?"}, but the statement says closing{" "}
                  {extraction.closingBalance}
                  {discrepancy != null && discrepancy !== 0n && (
                    <> — off by <strong>{fromCents(discrepancy)}</strong></>
                  )}
                  . A transaction may be missing, duplicated, or misread. Fix the rows below before
                  importing.
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
              {extraction.periodStart && extraction.periodEnd && (
                <span>Period: {extraction.periodStart} → {extraction.periodEnd}</span>
              )}
              <span>Opening: {extraction.openingBalance}</span>
              <span>Closing: {extraction.closingBalance}</span>
              <span>{txns.length} transactions</span>
            </div>

            <div className="border border-border rounded-md overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-accent/30 text-left">
                  <tr>
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Description</th>
                    <th className="px-3 py-2 font-medium text-right">Amount (− = money out)</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {txns.map((t, i) => (
                    <tr
                      key={i}
                      className={`border-t border-border ${t.lowConfidence ? "bg-amber-500/10" : ""}`}
                      data-testid={`row-statement-txn-${i}`}
                    >
                      <td className="px-2 py-1 w-36">
                        <Input
                          value={t.date}
                          onChange={(e) => update(i, { date: e.target.value })}
                          className="h-8 font-mono text-xs"
                          data-testid={`input-txn-date-${i}`}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <div className="flex items-center gap-2">
                          <Input
                            value={t.description}
                            onChange={(e) => update(i, { description: e.target.value })}
                            className="h-8"
                            data-testid={`input-txn-description-${i}`}
                          />
                          {t.lowConfidence && (
                            <Badge variant="outline" className="border-amber-500/60 text-amber-600 shrink-0" data-testid={`badge-low-confidence-${i}`}>
                              check
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-1 w-36">
                        <Input
                          value={t.amount}
                          onChange={(e) => update(i, { amount: e.target.value })}
                          className={`h-8 text-right font-mono text-xs ${toCents(t.amount) == null ? "border-destructive" : ""}`}
                          data-testid={`input-txn-amount-${i}`}
                        />
                      </td>
                      <td className="px-2 py-1 w-10">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setTxns((prev) => prev.filter((_, j) => j !== i))}
                          data-testid={`button-delete-txn-${i}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 justify-between items-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setTxns((prev) => [
                    ...prev,
                    { date: "", description: "", amount: "", lowConfidence: false },
                  ])
                }
                className="gap-1"
                data-testid="button-add-txn"
              >
                <Plus className="w-3.5 h-3.5" /> Add row
              </Button>
              <div className="flex gap-3">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setExtraction(null);
                    setTxns([]);
                  }}
                  data-testid="button-cancel-statement"
                >
                  Cancel
                </Button>
                <Button
                  onClick={onConfirm}
                  disabled={confirm.isPending || txns.length === 0 || invalidRows > 0}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                  data-testid="button-confirm-statement"
                >
                  {confirm.isPending
                    ? "Importing…"
                    : `Import ${txns.length} transaction${txns.length === 1 ? "" : "s"}`}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Importing adds these as uncategorized bank transactions — nothing posts to the ledger
              until you categorize each one in Reconcile. Re-uploading the same statement won't
              create duplicates.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
