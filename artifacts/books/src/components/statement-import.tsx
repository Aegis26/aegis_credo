import { useRef, useState } from "react";
import {
  useExtractBankStatement,
  useConfirmBankStatement,
  useListAccounts,
  getGetBankStatusQueryKey,
  getListBankTransactionsQueryKey,
  getListAccountsQueryKey,
  getApiErrorMessage,
} from "@workspace/api-client-react";
import type { BankStatementExtraction } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Spinner } from "@/components/ui/spinner";
import {
  FileText,
  AlertTriangle,
  CheckCircle,
  Trash2,
  Plus,
  Upload,
  ArrowLeftRight,
} from "lucide-react";
import { Link } from "wouter";

interface EditableTxn {
  date: string;
  description: string;
  amount: string; // signed decimal string, negative = money out
  lowConfidence: boolean;
  chainBreak: boolean;
  transferGroup: string | null;
  excluded: boolean;
}

interface EditableAccount {
  accountName: string;
  accountNumberLast4: string | null;
  openingBalance: string;
  closingBalance: string;
  // Mapping: existing ledger cash account id, or "new" with code+name.
  mapping: string; // "" = unmapped, "new" = create, otherwise account id
  newCode: string;
  newName: string;
  txns: EditableTxn[];
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

/**
 * Per-account live balance check over ALL rows — including excluded ones.
 * Exclusion is a review decision (don't import this transfer leg), not a
 * correction: every row must still tie out to the statement's closing
 * balance. The server enforces the same invariant on confirm.
 */
function accountCheck(acct: EditableAccount) {
  const opening = toCents(acct.openingBalance);
  const closing = toCents(acct.closingBalance);
  let invalidRows = 0;
  let computed = opening;
  if (computed != null) {
    for (const t of acct.txns) {
      const c = toCents(t.amount);
      if (c == null) invalidRows++;
      else computed += c;
    }
  }
  const discrepancy = computed != null && closing != null ? closing - computed : null;
  return {
    computed,
    discrepancy,
    invalidRows,
    balanced: discrepancy === 0n && invalidRows === 0,
  };
}

export function StatementImport({ orgId }: { orgId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [extraction, setExtraction] = useState<BankStatementExtraction | null>(null);
  const [accounts, setAccounts] = useState<EditableAccount[]>([]);
  const [done, setDone] = useState<{ inserted: number; skippedDuplicates: number } | null>(null);

  const extract = useExtractBankStatement();
  const confirm = useConfirmBankStatement();
  const { data: coaData } = useListAccounts(orgId);
  const assetAccounts = (coaData?.accounts ?? []).filter((a) => a.type === "asset");

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
      setAccounts(
        result.accounts.map((a) => ({
          accountName: a.accountName,
          accountNumberLast4: a.accountNumberLast4,
          openingBalance: a.openingBalance,
          closingBalance: a.closingBalance,
          mapping: "",
          newCode: "",
          newName: a.accountName,
          txns: a.transactions.map((t) => ({ ...t, excluded: false })),
        })),
      );
    } catch (e: unknown) {
      const msg = getApiErrorMessage(e, "We couldn't read this statement. Please try again.");
      toast({ variant: "destructive", title: "Extraction failed", description: msg });
    }
  };

  const checks = accounts.map(accountCheck);
  const allBalanced = checks.every((c) => c.balanced);
  const anyInvalid = checks.some((c) => c.invalidRows > 0);
  const unmapped = accounts.filter(
    (a) => !a.mapping || (a.mapping === "new" && (!a.newCode.trim() || !a.newName.trim())),
  ).length;
  const includedCount = accounts.reduce(
    (n, a) => n + a.txns.filter((t) => !t.excluded).length,
    0,
  );

  // Statement-level cross-check recomputed live from the editable closings.
  const statedTotal = extraction?.statementTotalEndingBalance != null
    ? toCents(extraction.statementTotalEndingBalance)
    : null;
  let sumClosings: bigint | null = 0n;
  for (const a of accounts) {
    const c = toCents(a.closingBalance);
    if (c == null) { sumClosings = null; break; }
    sumClosings += c;
  }
  const totalMatches = statedTotal != null && sumClosings != null ? statedTotal === sumClosings : null;

  const onConfirm = async () => {
    try {
      const result = await confirm.mutateAsync({
        orgId,
        data: {
          accounts: accounts.map((a) => ({
            accountName: a.accountName,
            accountNumberLast4: a.accountNumberLast4,
            openingBalance: a.openingBalance.trim(),
            closingBalance: a.closingBalance.trim(),
            cashAccountId: a.mapping !== "new" && a.mapping ? a.mapping : null,
            newAccount:
              a.mapping === "new"
                ? { code: a.newCode.trim(), name: a.newName.trim() }
                : null,
            transactions: a.txns.map((t) => ({
              date: t.date,
              description: t.description,
              amount: t.amount.trim(),
              excluded: t.excluded,
            })),
          })),
        },
      });
      setDone(result);
      setExtraction(null);
      setAccounts([]);
      queryClient.invalidateQueries({ queryKey: getGetBankStatusQueryKey(orgId) });
      queryClient.invalidateQueries({ queryKey: getListBankTransactionsQueryKey(orgId) });
      queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey(orgId) });
    } catch (e: unknown) {
      const msg = getApiErrorMessage(e, "Import failed. Please check the rows and try again.");
      toast({ variant: "destructive", title: "Import failed", description: msg });
    }
  };

  const updateAccount = (ai: number, patch: Partial<EditableAccount>) =>
    setAccounts((prev) => prev.map((a, j) => (j === ai ? { ...a, ...patch } : a)));
  const updateTxn = (ai: number, ti: number, patch: Partial<EditableTxn>) =>
    setAccounts((prev) =>
      prev.map((a, j) =>
        j === ai
          ? { ...a, txns: a.txns.map((t, k) => (k === ti ? { ...t, ...patch } : t)) }
          : a,
      ),
    );
  /** Toggle exclusion for BOTH legs of a transfer group at once. */
  const toggleTransferGroup = (group: string, excluded: boolean) =>
    setAccounts((prev) =>
      prev.map((a) => ({
        ...a,
        txns: a.txns.map((t) => (t.transferGroup === group ? { ...t, excluded } : t)),
      })),
    );

  return (
    <Card className="shadow-none border-border bg-card" data-testid="card-statement-import">
      <CardHeader className="border-b border-border bg-accent/30 pb-4">
        <div className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-primary" />
          <CardTitle>Import Statement (PDF)</CardTitle>
        </div>
        <CardDescription>
          No bank connection? Upload a PDF statement — transactions land in Reconcile for your
          review, exactly like a bank feed. Multi-account statements are supported.
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
                  Reading your statement… this can take up to a minute for scanned or multi-account
                  documents.
                </p>
              </div>
            ) : (
              <>
                <Upload className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-40" />
                <p className="font-medium text-foreground">Drop your bank statement here</p>
                <p className="text-sm text-muted-foreground mt-1">
                  PDF only, up to 10 MB. Works with scanned and multi-account statements. Nothing is
                  posted without your review.
                </p>
              </>
            )}
          </div>
        )}

        {extraction && (
          <div className="space-y-5" data-testid="section-statement-review">
            {/* STATEMENT-LEVEL CROSS-CHECK — the catch-all. If a whole account
                were missed, per-account checks would pass while this fails. */}
            {statedTotal != null && (
              totalMatches ? (
                <Alert className="border-[#3CB54A]/40 bg-[#3CB54A]/10" data-testid="alert-total-match">
                  <CheckCircle className="h-4 w-4 text-[#3CB54A]" />
                  <AlertTitle>
                    Statement total ties out ✓ — {extraction.statementTotalEndingBalance}
                  </AlertTitle>
                  <AlertDescription>
                    The {accounts.length} account closing balance{accounts.length === 1 ? "" : "s"} sum
                    to the statement's stated total ending balance.
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert variant="destructive" className="bg-destructive/10 border-destructive/40" data-testid="alert-total-mismatch">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Statement total doesn't tie out</AlertTitle>
                  <AlertDescription>
                    The statement says the combined ending balance is{" "}
                    <strong>{extraction.statementTotalEndingBalance}</strong>, but the extracted
                    accounts' closing balances sum to{" "}
                    <strong>{sumClosings != null ? fromCents(sumClosings) : "?"}</strong>. An entire
                    account may have been missed or a closing balance misread — check before
                    importing.
                  </AlertDescription>
                </Alert>
              )
            )}

            {extraction.periodStart && extraction.periodEnd && (
              <p className="text-sm text-muted-foreground">
                Period: {extraction.periodStart} → {extraction.periodEnd} · {accounts.length}{" "}
                account{accounts.length === 1 ? "" : "s"} · {includedCount} transactions to import
              </p>
            )}

            {accounts.map((acct, ai) => {
              const check = checks[ai];
              return (
                <div key={ai} className="border border-border rounded-md" data-testid={`section-account-${ai}`}>
                  <div className="px-4 py-3 bg-accent/30 border-b border-border space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-medium">
                        {acct.accountName}
                        {acct.accountNumberLast4 && (
                          <span className="text-muted-foreground font-normal"> ····{acct.accountNumberLast4}</span>
                        )}
                      </div>
                      {check.balanced ? (
                        <Badge className="bg-[#3CB54A]/15 text-[#2e8b3a] border border-[#3CB54A]/40" data-testid={`badge-account-balanced-${ai}`}>
                          <CheckCircle className="w-3 h-3 mr-1" /> Balanced ✓
                        </Badge>
                      ) : (
                        <Badge variant="destructive" data-testid={`badge-account-discrepancy-${ai}`}>
                          <AlertTriangle className="w-3 h-3 mr-1" />
                          {check.invalidRows > 0
                            ? `${check.invalidRows} invalid row(s)`
                            : `Off by ${check.discrepancy != null ? fromCents(check.discrepancy) : "?"}`}
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                      <span>Opening: {acct.openingBalance}</span>
                      <span>Closing: {acct.closingBalance}</span>
                      <span>{acct.txns.filter((t) => !t.excluded).length} to import</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium">Import into cash account:</span>
                      <Select
                        value={acct.mapping}
                        onValueChange={(v) => updateAccount(ai, { mapping: v })}
                      >
                        <SelectTrigger className="h-8 w-64" data-testid={`select-cash-account-${ai}`}>
                          <SelectValue placeholder="Choose a ledger account…" />
                        </SelectTrigger>
                        <SelectContent>
                          {assetAccounts.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.code} — {a.name}
                            </SelectItem>
                          ))}
                          <SelectItem value="new">+ Create a new cash account</SelectItem>
                        </SelectContent>
                      </Select>
                      {acct.mapping === "new" && (
                        <div className="flex gap-2">
                          <Input
                            value={acct.newCode}
                            onChange={(e) => updateAccount(ai, { newCode: e.target.value })}
                            placeholder="Code e.g. 1010"
                            className="h-8 w-28 font-mono text-xs"
                            data-testid={`input-new-account-code-${ai}`}
                          />
                          <Input
                            value={acct.newName}
                            onChange={(e) => updateAccount(ai, { newName: e.target.value })}
                            placeholder="Account name"
                            className="h-8 w-48"
                            data-testid={`input-new-account-name-${ai}`}
                          />
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-accent/20 text-left">
                        <tr>
                          <th className="px-3 py-2 font-medium">Date</th>
                          <th className="px-3 py-2 font-medium">Description</th>
                          <th className="px-3 py-2 font-medium text-right">Amount (− = out)</th>
                          <th className="px-3 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {acct.txns.map((t, ti) => (
                          <tr
                            key={ti}
                            className={`border-t border-border ${
                              t.excluded
                                ? "opacity-40"
                                : t.transferGroup
                                  ? "bg-violet-500/10"
                                  : t.lowConfidence || t.chainBreak
                                    ? "bg-amber-500/10"
                                    : ""
                            }`}
                            data-testid={`row-txn-${ai}-${ti}`}
                          >
                            <td className="px-2 py-1 w-36">
                              <Input
                                value={t.date}
                                onChange={(e) => updateTxn(ai, ti, { date: e.target.value })}
                                className="h-8 font-mono text-xs"
                                disabled={t.excluded}
                                data-testid={`input-txn-date-${ai}-${ti}`}
                              />
                            </td>
                            <td className="px-2 py-1">
                              <div className="flex items-center gap-2">
                                <Input
                                  value={t.description}
                                  onChange={(e) => updateTxn(ai, ti, { description: e.target.value })}
                                  className="h-8"
                                  disabled={t.excluded}
                                  data-testid={`input-txn-description-${ai}-${ti}`}
                                />
                                {t.transferGroup && (
                                  <Badge
                                    className="bg-violet-600 text-white border-violet-700 shrink-0 gap-1"
                                    data-testid={`badge-transfer-${ai}-${ti}`}
                                  >
                                    <ArrowLeftRight className="w-3 h-3" /> Internal transfer?
                                  </Badge>
                                )}
                                {t.lowConfidence && !t.transferGroup && (
                                  <Badge variant="outline" className="border-amber-500/60 text-amber-600 shrink-0" data-testid={`badge-low-confidence-${ai}-${ti}`}>
                                    check
                                  </Badge>
                                )}
                                {t.chainBreak && (
                                  <Badge variant="outline" className="border-amber-500/60 text-amber-600 shrink-0" data-testid={`badge-chain-break-${ai}-${ti}`}>
                                    balance doesn't chain
                                  </Badge>
                                )}
                              </div>
                            </td>
                            <td className="px-2 py-1 w-36">
                              <Input
                                value={t.amount}
                                onChange={(e) => updateTxn(ai, ti, { amount: e.target.value })}
                                className={`h-8 text-right font-mono text-xs ${!t.excluded && toCents(t.amount) == null ? "border-destructive" : ""}`}
                                disabled={t.excluded}
                                data-testid={`input-txn-amount-${ai}-${ti}`}
                              />
                            </td>
                            <td className="px-2 py-1 w-32 text-right whitespace-nowrap">
                              {t.transferGroup ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-xs"
                                  onClick={() => toggleTransferGroup(t.transferGroup!, !t.excluded)}
                                  data-testid={`button-toggle-transfer-${ai}-${ti}`}
                                >
                                  {t.excluded ? "Include both legs" : "Exclude both legs"}
                                </Button>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    setAccounts((prev) =>
                                      prev.map((a, j) =>
                                        j === ai
                                          ? { ...a, txns: a.txns.filter((_, k) => k !== ti) }
                                          : a,
                                      ),
                                    )
                                  }
                                  data-testid={`button-delete-txn-${ai}-${ti}`}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="px-3 py-2 border-t border-border">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setAccounts((prev) =>
                          prev.map((a, j) =>
                            j === ai
                              ? {
                                  ...a,
                                  txns: [
                                    ...a.txns,
                                    {
                                      date: "",
                                      description: "",
                                      amount: "",
                                      lowConfidence: false,
                                      chainBreak: false,
                                      transferGroup: null,
                                      excluded: false,
                                    },
                                  ],
                                }
                              : a,
                          ),
                        )
                      }
                      className="gap-1"
                      data-testid={`button-add-txn-${ai}`}
                    >
                      <Plus className="w-3.5 h-3.5" /> Add row
                    </Button>
                  </div>
                </div>
              );
            })}

            {accounts.some((a) => a.txns.some((t) => t.transferGroup && !t.excluded)) && (
              <Alert className="border-violet-500/40 bg-violet-500/10" data-testid="alert-transfers">
                <ArrowLeftRight className="h-4 w-4 text-violet-600" />
                <AlertTitle>Possible internal transfers detected</AlertTitle>
                <AlertDescription>
                  Rows marked <strong>Internal transfer?</strong> look like the same money moving
                  between your own accounts on this statement. If you import both legs and
                  categorize them as income/expense, they will double-count in your P&L. Keep them
                  and categorize carefully, or use "Exclude both legs".
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col sm:flex-row gap-3 justify-between items-center">
              <p className="text-xs text-muted-foreground">
                {unmapped > 0 && (
                  <span className="text-destructive font-medium">
                    Map {unmapped} account{unmapped === 1 ? "" : "s"} to a cash account to enable
                    import.{" "}
                  </span>
                )}
                {!allBalanced && "Fix the flagged discrepancies before importing. "}
              </p>
              <div className="flex gap-3">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setExtraction(null);
                    setAccounts([]);
                  }}
                  data-testid="button-cancel-statement"
                >
                  Cancel
                </Button>
                <Button
                  onClick={onConfirm}
                  disabled={
                    confirm.isPending ||
                    includedCount === 0 ||
                    anyInvalid ||
                    unmapped > 0 ||
                    !allBalanced
                  }
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                  data-testid="button-confirm-statement"
                >
                  {confirm.isPending
                    ? "Importing…"
                    : `Import ${includedCount} transaction${includedCount === 1 ? "" : "s"}`}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Importing adds these as uncategorized bank transactions tied to the cash account you
              chose — nothing posts to the ledger until you categorize each one in Reconcile.
              Re-uploading the same statement won't create duplicates.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
