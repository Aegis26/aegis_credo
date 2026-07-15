import { useState, useRef } from "react";
import { useCurrentOrg } from "@/hooks/use-current-org";
import {
  useImportAccountingFile,
  usePreviewImport,
  useCreateOrg,
  getGetOrgDashboardQueryKey,
  getListInvoicesQueryKey,
  getGetArAgingQueryKey,
  getListBillsQueryKey,
  getListMyOrgsQueryKey,
  ApiError,
  type ReconciliationReport,
  type ImportPreviewResult,
  type ImportFileInput,
  type ImportPreviewAccountType,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  UploadCloud,
  FileSpreadsheet,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  RotateCcw,
} from "lucide-react";

type Step = "upload" | "review" | "done";

/** The two ways we get a canonical draft: a raw JSON export, or a parsed CSV/XLSX preview. */
interface JsonSource {
  kind: "json";
  draft: ImportFileInput;
  counts: {
    accounts: number;
    opening: number;
    transactions: number;
    invoices: number;
    bills: number;
  };
  sourceLabel: string;
}
interface AdapterSource {
  kind: "adapter";
  preview: ImportPreviewResult;
}
type ReviewSource = JsonSource | AdapterSource;

const ACCOUNT_TYPES: ImportPreviewAccountType[] = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
];

/** Integer-safe minor units (as string) → decimal string. Never touches float. */
function minorToDecimal(minor: string): string {
  if (!minor) return "0.00";
  const neg = minor.startsWith("-");
  const digits = (neg ? minor.slice(1) : minor).replace(/[^0-9]/g, "").padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(-2);
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** Read a File as base64 (used for binary .xlsx uploads). */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("Could not read this file."));
    reader.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read this file."));
    reader.readAsText(file);
  });
}

export default function ImportPage() {
  const { orgId, setOrg } = useCurrentOrg();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);

  const [raw, setRaw] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("upload");
  const [source, setSource] = useState<ReviewSource | null>(null);
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  // Per-account type confirmations from the Review step, keyed by account name.
  const [typeChoices, setTypeChoices] = useState<Record<string, ImportPreviewAccountType>>({});

  const importFile = useImportAccountingFile();
  const previewImport = usePreviewImport();
  const createOrg = useCreateOrg();
  // Multi-import guard dialog state.
  const [guardOpen, setGuardOpen] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");

  const tryParseJson = (text: string) => {
    setRaw(text);
    setParseError(null);
    if (!text.trim()) {
      setSource(null);
      return;
    }
    try {
      const obj = JSON.parse(text) as ImportFileInput & {
        transactions?: unknown[];
        openInvoices?: unknown[];
        openBills?: unknown[];
      };
      if (!obj.source || !Array.isArray(obj.accounts)) {
        throw new Error("File must have a 'source' and an 'accounts' array.");
      }
      setSource({
        kind: "json",
        draft: obj,
        sourceLabel: obj.source,
        counts: {
          accounts: obj.accounts?.length ?? 0,
          opening: obj.openingBalances?.length ?? 0,
          transactions: obj.transactions?.length ?? 0,
          invoices: obj.openInvoices?.length ?? 0,
          bills: obj.openBills?.length ?? 0,
        },
      });
      setStep("review");
    } catch (e) {
      setSource(null);
      setParseError(e instanceof Error ? e.message : "Invalid JSON file.");
    }
  };

  const runPreview = async (
    contentType: "csv" | "xlsx",
    content: string,
    filename?: string,
  ) => {
    if (!orgId) return;
    setParseError(null);
    try {
      const preview = await previewImport.mutateAsync({
        orgId,
        data: { report: "qbo_trial_balance", contentType, content, filename },
      });
      setSource({ kind: "adapter", preview });
      // Seed the Review selectors ONLY for accounts the adapter resolved
      // (mapped/inherited). Ambiguous accounts start EMPTY — the user must
      // make an explicit choice; we never pre-select a default for them.
      const seeded: Record<string, ImportPreviewAccountType> = {};
      for (const a of preview.accounts) {
        if (a.typeSource !== "ambiguous") seeded[a.name] = a.type;
      }
      setTypeChoices(seeded);
      setStep("review");
    } catch (e) {
      setSource(null);
      setParseError(
        e instanceof Error ? e.message : "We couldn't read this file.",
      );
    }
  };

  const onFile = async (file: File) => {
    setParseError(null);
    const name = file.name.toLowerCase();
    try {
      if (name.endsWith(".json")) {
        tryParseJson(await readAsText(file));
      } else if (name.endsWith(".xlsx")) {
        await runPreview("xlsx", await readAsBase64(file), file.name);
      } else {
        // Treat everything else (.csv, .txt) as CSV text.
        await runPreview("csv", await readAsText(file), file.name);
      }
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Could not read this file.");
    }
  };

  /** Apply the user's Review-step type choices to an adapter draft before posting. */
  const draftWithChoices = (preview: ImportPreviewResult): ImportFileInput => {
    const nameToChoice = typeChoices;
    return {
      ...preview.draft,
      accounts: preview.draft.accounts.map((a) => {
        // Match the draft account back to the preview account by code, then name.
        const previewAcc = preview.accounts.find((p) => p.code === a.code);
        const chosen = previewAcc ? nameToChoice[previewAcc.name] : undefined;
        return chosen ? { ...a, type: chosen } : a;
      }),
    };
  };

  /**
   * Post the import. The multi-import guard: if this org already has imported
   * opening balances (from a DIFFERENT file), we never silently post — a
   * dialog offers cancel / new org / replace. The server enforces the same
   * rule (409) so the guard holds even if the client state is stale.
   */
  const runImport = async (opts: { targetOrgId?: string; replace?: boolean } = {}) => {
    const target = opts.targetOrgId ?? orgId;
    if (!target || !source) return;
    const draft =
      source.kind === "json" ? source.draft : draftWithChoices(source.preview);

    const hasOpening = (draft.openingBalances?.length ?? 0) > 0;
    const knownConflict =
      source.kind === "adapter" && source.preview.hasExistingOpeningBalances;
    if (!opts.replace && !opts.targetOrgId && hasOpening && knownConflict) {
      setGuardOpen(true);
      return;
    }

    try {
      const result = await importFile.mutateAsync({
        orgId: target,
        data: { ...draft, onExistingOpening: opts.replace ? "replace" : "block" },
      });
      setGuardOpen(false);
      if (opts.targetOrgId && opts.targetOrgId !== orgId) setOrg(opts.targetOrgId);
      setReport(result);
      setStep("done");
      queryClient.invalidateQueries({ queryKey: getGetOrgDashboardQueryKey(target) });
      queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey(target) });
      queryClient.invalidateQueries({ queryKey: getListBillsQueryKey(target) });
      queryClient.invalidateQueries({ queryKey: getGetArAgingQueryKey(target) });
      toast({ title: "Import complete", description: "Your books have been migrated in." });
    } catch (e) {
      // Server-side guard: the org already has imported opening balances.
      if (e instanceof ApiError && e.status === 409) {
        setGuardOpen(true);
        return;
      }
      toast({
        variant: "destructive",
        title: "Import failed",
        description: e instanceof Error ? e.message : "Could not import this file.",
      });
    }
  };

  /** Guard option (b): create a fresh org and import there instead. */
  const importIntoNewOrg = async () => {
    if (!newOrgName.trim()) return;
    try {
      const org = await createOrg.mutateAsync({ data: { name: newOrgName.trim() } });
      await queryClient.invalidateQueries({ queryKey: getListMyOrgsQueryKey() });
      await runImport({ targetOrgId: org.id });
      setNewOrgName("");
    } catch {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Could not create the new organization.",
      });
    }
  };

  const reset = () => {
    setRaw("");
    setSource(null);
    setParseError(null);
    setReport(null);
    setTypeChoices({});
    setStep("upload");
  };

  if (!orgId) return null;

  const previewing = previewImport.isPending;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Migrate your books</h1>
        <p className="text-muted-foreground mt-1">
          Bring your history over from QuickBooks or Xero. Upload a Trial Balance (CSV or Excel)
          or a normalized JSON export — every balance posts through the double-entry ledger and we
          prove the numbers reconcile, exactly.
        </p>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-2 text-sm">
        {(["upload", "review", "done"] as Step[]).map((s, i) => {
          const labels = { upload: "Upload export", review: "Review", done: "Reconciliation" };
          const active = step === s;
          const complete = (["upload", "review", "done"] as Step[]).indexOf(step) > i;
          return (
            <div key={s} className="flex items-center gap-2">
              <span
                className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : complete
                      ? "bg-primary/20 text-primary"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                {complete ? "✓" : i + 1}
              </span>
              <span className={active ? "font-medium text-foreground" : "text-muted-foreground"}>
                {labels[s]}
              </span>
              {i < 2 && <ArrowRight className="w-4 h-4 text-muted-foreground/50" />}
            </div>
          );
        })}
      </div>

      {step === "upload" && (
        <Card className="shadow-sm border-border">
          <CardHeader>
            <CardTitle>Upload your export file</CardTitle>
            <CardDescription>
              A QuickBooks "Trial Balance" export (.csv or .xlsx), or a normalized QuickBooks/Xero
              JSON file.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              className={`border-2 border-dashed border-border rounded-lg p-10 text-center cursor-pointer hover:bg-muted/30 transition-colors ${
                previewing ? "opacity-60 pointer-events-none" : ""
              }`}
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) onFile(f);
              }}
            >
              <UploadCloud className="w-10 h-10 mx-auto mb-3 text-primary/60" />
              <p className="font-medium">
                {previewing ? "Reading your file…" : "Drop your export here, or click to browse"}
              </p>
              <p className="text-sm text-muted-foreground mt-1">.csv, .xlsx or .json</p>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.xlsx,.json,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onFile(f);
                }}
              />
            </div>
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground">or paste JSON</span>
              </div>
            </div>
            <Textarea
              placeholder='{"source":"quickbooks","accounts":[...],"openingBalances":[...]}'
              value={raw}
              onChange={(e) => tryParseJson(e.target.value)}
              className="font-mono text-xs h-40"
            />
            {parseError && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="w-4 h-4" />
                {parseError}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {step === "review" && source?.kind === "json" && (
        <Card className="shadow-sm border-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-primary" />
              Review — {source.sourceLabel}
            </CardTitle>
            <CardDescription>
              Here's what we'll import. Re-importing the same file is safe: nothing posts twice.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
              {[
                ["Accounts", source.counts.accounts],
                ["Opening", source.counts.opening],
                ["Transactions", source.counts.transactions],
                ["Invoices", source.counts.invoices],
                ["Bills", source.counts.bills],
              ].map(([label, n]) => (
                <div key={label} className="rounded-lg border border-border p-4 text-center">
                  <div className="text-2xl font-serif text-primary">{n}</div>
                  <div className="text-xs text-muted-foreground mt-1">{label}</div>
                </div>
              ))}
            </div>
            <div className="flex gap-3">
              <Button onClick={() => runImport()} disabled={importFile.isPending} className="gap-2">
                {importFile.isPending ? "Importing…" : "Import & reconcile"}
                {!importFile.isPending && <ArrowRight className="w-4 h-4" />}
              </Button>
              <Button variant="outline" onClick={reset} className="gap-2">
                <RotateCcw className="w-4 h-4" />
                Start over
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "review" && source?.kind === "adapter" && (
        <AdapterReview
          preview={source.preview}
          typeChoices={typeChoices}
          setTypeChoices={setTypeChoices}
          onImport={() => runImport()}
          onReset={reset}
          importing={importFile.isPending}
        />
      )}

      <Dialog open={guardOpen} onOpenChange={setGuardOpen}>
        <DialogContent data-testid="dialog-import-guard">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-destructive" />
              This organization already has imported opening balances
            </DialogTitle>
            <DialogDescription>
              Importing another file on top of them would double your books.
              Choose how to proceed — nothing has been posted yet.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-md border border-border p-3 space-y-2">
              <p className="text-sm font-medium">Import into a new organization</p>
              <p className="text-sm text-muted-foreground">
                Keeps the current books untouched and puts this file into a
                fresh set of books.
              </p>
              <div className="space-y-2">
                <Label htmlFor="guard-new-org-name">New organization name</Label>
                <div className="flex gap-2">
                  <Input
                    id="guard-new-org-name"
                    data-testid="input-guard-new-org-name"
                    value={newOrgName}
                    onChange={(e) => setNewOrgName(e.target.value)}
                    placeholder="Acme LLC (new books)"
                  />
                  <Button
                    variant="secondary"
                    onClick={importIntoNewOrg}
                    disabled={!newOrgName.trim() || createOrg.isPending || importFile.isPending}
                    data-testid="button-guard-new-org"
                  >
                    {createOrg.isPending || importFile.isPending ? "Working…" : "Create & import"}
                  </Button>
                </div>
              </div>
            </div>
            <div className="rounded-md border border-destructive/40 p-3 space-y-2">
              <p className="text-sm font-medium">Replace the existing opening balances</p>
              <p className="text-sm text-muted-foreground">
                The prior opening entries are reversed with new reversing
                entries (they stay in the ledger for the audit trail), then
                this file's opening balances are posted.
              </p>
              <Button
                variant="destructive"
                onClick={() => runImport({ replace: true })}
                disabled={importFile.isPending}
                data-testid="button-guard-replace"
              >
                {importFile.isPending ? "Replacing…" : "Reverse & replace"}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setGuardOpen(false)}
              data-testid="button-guard-cancel"
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {step === "done" && report && (
        <Card className="shadow-sm border-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {report.matched ? (
                <CheckCircle2 className="w-5 h-5 text-primary" />
              ) : (
                <AlertCircle className="w-5 h-5 text-destructive" />
              )}
              Reconciliation report
            </CardTitle>
            <CardDescription>
              {report.matched
                ? "The ledger reproduces your source's trial balance exactly."
                : "The ledger did not fully match the source — review the accounts below."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex flex-wrap gap-3">
              <Badge variant={report.matched ? "default" : "destructive"}>
                {report.matched ? "Matched" : "Mismatch"}
              </Badge>
              <Badge variant={report.sourceBalanced ? "secondary" : "destructive"}>
                {report.sourceBalanced ? "Source balanced" : "Source unbalanced"}
              </Badge>
              <Badge variant="outline">{report.entriesPosted} entries posted</Badge>
              <Badge variant="outline">{report.invoicesCreated} invoices</Badge>
              <Badge variant="outline">{report.billsCreated} bills</Badge>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Account</th>
                    <th className="py-2 px-4 font-medium text-right">Source Dr</th>
                    <th className="py-2 px-4 font-medium text-right">Source Cr</th>
                    <th className="py-2 px-4 font-medium text-right">Ledger Dr</th>
                    <th className="py-2 px-4 font-medium text-right">Ledger Cr</th>
                    <th className="py-2 pl-4 font-medium text-center">Match</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {report.accounts.map((a) => (
                    <tr key={a.code}>
                      <td className="py-2 pr-4">
                        <span className="text-muted-foreground">{a.code}</span> {a.name}
                      </td>
                      <td className="py-2 px-4 text-right font-mono">${a.sourceDebit}</td>
                      <td className="py-2 px-4 text-right font-mono">${a.sourceCredit}</td>
                      <td className="py-2 px-4 text-right font-mono">${a.ledgerDebit}</td>
                      <td className="py-2 px-4 text-right font-mono">${a.ledgerCredit}</td>
                      <td className="py-2 pl-4 text-center">
                        {a.matched ? (
                          <CheckCircle2 className="w-4 h-4 text-primary inline" />
                        ) : (
                          <AlertCircle className="w-4 h-4 text-destructive inline" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border font-medium">
                    <td className="py-2 pr-4">Total</td>
                    <td className="py-2 px-4 text-right font-mono">${report.sourceTotalDebit}</td>
                    <td className="py-2 px-4 text-right font-mono">${report.sourceTotalCredit}</td>
                    <td className="py-2 px-4 text-right font-mono">${report.ledgerTotalDebit}</td>
                    <td className="py-2 px-4 text-right font-mono">${report.ledgerTotalCredit}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>

            <Button variant="outline" onClick={reset} className="gap-2">
              <RotateCcw className="w-4 h-4" />
              Import another file
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Review step for adapter (CSV/XLSX) imports: shows parsed accounts and lets the
 * user confirm the type of any account the adapter couldn't map with confidence. */
function AdapterReview({
  preview,
  typeChoices,
  setTypeChoices,
  onImport,
  onReset,
  importing,
}: {
  preview: ImportPreviewResult;
  typeChoices: Record<string, ImportPreviewAccountType>;
  setTypeChoices: React.Dispatch<
    React.SetStateAction<Record<string, ImportPreviewAccountType>>
  >;
  onImport: () => void;
  onReset: () => void;
  importing: boolean;
}) {
  const ambiguous = preview.accounts.filter((a) => a.typeSource === "ambiguous");
  // Ambiguous accounts have NO default — the import stays blocked until the
  // user has explicitly chosen a category for every one of them.
  const unchosen = ambiguous.filter((a) => !typeChoices[a.name]).length;
  return (
    <Card className="shadow-sm border-border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSpreadsheet className="w-5 h-5 text-primary" />
          Review — {preview.companyName ?? preview.source}
        </CardTitle>
        <CardDescription>
          {preview.asOf ? `${preview.asOf}. ` : ""}
          We read {preview.accounts.length} accounts.{" "}
          {ambiguous.length > 0
            ? `${ambiguous.length} need a category confirmed before we post.`
            : "Every account was categorized automatically."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap gap-3">
          <Badge variant={preview.balanced ? "secondary" : "destructive"}>
            {preview.balanced ? "Trial balance balanced" : "Unbalanced — will plug to equity"}
          </Badge>
          <Badge variant="outline">Dr ${minorToDecimal(preview.totalDebit)}</Badge>
          <Badge variant="outline">Cr ${minorToDecimal(preview.totalCredit)}</Badge>
          {ambiguous.length > 0 && (
            <Badge variant="destructive">{ambiguous.length} to review</Badge>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Account</th>
                <th className="py-2 px-4 font-medium text-right">Debit</th>
                <th className="py-2 px-4 font-medium text-right">Credit</th>
                <th className="py-2 pl-4 font-medium">Category</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {preview.accounts.map((a) => {
                const needsReview = a.typeSource === "ambiguous";
                return (
                  <tr
                    key={a.code}
                    className={needsReview ? "bg-destructive/5" : undefined}
                  >
                    <td className="py-2 pr-4">
                      {a.name}
                      {needsReview && (
                        <span className="ml-2 inline-flex items-center gap-1 text-xs text-destructive">
                          <AlertCircle className="w-3 h-3" />
                          confirm
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-4 text-right font-mono">
                      {a.debit !== "0" ? `$${minorToDecimal(a.debit)}` : ""}
                    </td>
                    <td className="py-2 px-4 text-right font-mono">
                      {a.credit !== "0" ? `$${minorToDecimal(a.credit)}` : ""}
                    </td>
                    <td className="py-2 pl-4">
                      <Select
                        value={typeChoices[a.name] ?? ""}
                        onValueChange={(v) =>
                          setTypeChoices((prev) => ({
                            ...prev,
                            [a.name]: v as ImportPreviewAccountType,
                          }))
                        }
                      >
                        <SelectTrigger
                          className={`h-8 w-36 ${needsReview && !typeChoices[a.name] ? "border-destructive" : ""}`}
                        >
                          <SelectValue placeholder="Choose type…" />
                        </SelectTrigger>
                        <SelectContent>
                          {ACCOUNT_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {t[0].toUpperCase() + t.slice(1)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex gap-3">
            <Button
              onClick={onImport}
              disabled={importing || unchosen > 0}
              className="gap-2"
            >
              {importing ? "Importing…" : "Import & reconcile"}
              {!importing && <ArrowRight className="w-4 h-4" />}
            </Button>
            <Button variant="outline" onClick={onReset} className="gap-2">
              <RotateCcw className="w-4 h-4" />
              Start over
            </Button>
          </div>
          {unchosen > 0 && (
            <p className="text-sm text-destructive flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" />
              Choose a category for {unchosen} highlighted account
              {unchosen === 1 ? "" : "s"} before importing.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
