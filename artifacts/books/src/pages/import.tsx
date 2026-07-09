import { useState, useRef } from "react";
import { useCurrentOrg } from "@/hooks/use-current-org";
import {
  useImportAccountingFile,
  getGetOrgDashboardQueryKey,
  getListInvoicesQueryKey,
  getGetArAgingQueryKey,
  getListBillsQueryKey,
  type ReconciliationReport,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { UploadCloud, FileJson, CheckCircle2, AlertCircle, ArrowRight, RotateCcw } from "lucide-react";

type Step = "upload" | "review" | "done";

interface ParsedFile {
  source?: string;
  accounts?: unknown[];
  openingBalances?: unknown[];
  transactions?: unknown[];
  openInvoices?: unknown[];
  openBills?: unknown[];
}

export default function ImportPage() {
  const { orgId } = useCurrentOrg();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);

  const [raw, setRaw] = useState("");
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("upload");
  const [report, setReport] = useState<ReconciliationReport | null>(null);

  const importFile = useImportAccountingFile();

  const tryParse = (text: string) => {
    setRaw(text);
    setParseError(null);
    if (!text.trim()) {
      setParsed(null);
      return;
    }
    try {
      const obj = JSON.parse(text) as ParsedFile;
      if (!obj.source || !Array.isArray(obj.accounts)) {
        throw new Error("File must have a 'source' and an 'accounts' array.");
      }
      setParsed(obj);
      setStep("review");
    } catch (e) {
      setParsed(null);
      setParseError(e instanceof Error ? e.message : "Invalid JSON file.");
    }
  };

  const onFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => tryParse(String(reader.result));
    reader.readAsText(file);
  };

  const runImport = async () => {
    if (!orgId || !parsed) return;
    try {
      const result = await importFile.mutateAsync({
        orgId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: parsed as any,
      });
      setReport(result);
      setStep("done");
      queryClient.invalidateQueries({ queryKey: getGetOrgDashboardQueryKey(orgId) });
      queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey(orgId) });
      queryClient.invalidateQueries({ queryKey: getListBillsQueryKey(orgId) });
      queryClient.invalidateQueries({ queryKey: getGetArAgingQueryKey(orgId) });
      toast({ title: "Import complete", description: "Your books have been migrated in." });
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Import failed",
        description: e instanceof Error ? e.message : "Could not import this file.",
      });
    }
  };

  const reset = () => {
    setRaw("");
    setParsed(null);
    setParseError(null);
    setReport(null);
    setStep("upload");
  };

  if (!orgId) return null;

  const counts = parsed
    ? {
        accounts: parsed.accounts?.length ?? 0,
        opening: parsed.openingBalances?.length ?? 0,
        transactions: parsed.transactions?.length ?? 0,
        invoices: parsed.openInvoices?.length ?? 0,
        bills: parsed.openBills?.length ?? 0,
      }
    : null;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Migrate your books</h1>
        <p className="text-muted-foreground mt-1">
          Bring your history over from QuickBooks or Xero. Every transaction posts through the
          double-entry ledger and we prove the numbers reconcile — exactly.
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
              A normalized QuickBooks/Xero JSON export. All amounts are integer minor units.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              className="border-2 border-dashed border-border rounded-lg p-10 text-center cursor-pointer hover:bg-muted/30 transition-colors"
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) onFile(f);
              }}
            >
              <UploadCloud className="w-10 h-10 mx-auto mb-3 text-primary/60" />
              <p className="font-medium">Drop your export here, or click to browse</p>
              <p className="text-sm text-muted-foreground mt-1">.json files only</p>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
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
              placeholder='{"source":"quickbooks","accounts":[...],"transactions":[...]}'
              value={raw}
              onChange={(e) => tryParse(e.target.value)}
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

      {step === "review" && counts && (
        <Card className="shadow-sm border-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileJson className="w-5 h-5 text-primary" />
              Review — {parsed?.source}
            </CardTitle>
            <CardDescription>
              Here's what we'll import. Re-importing the same file is safe: nothing posts twice.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
              {[
                ["Accounts", counts.accounts],
                ["Opening", counts.opening],
                ["Transactions", counts.transactions],
                ["Invoices", counts.invoices],
                ["Bills", counts.bills],
              ].map(([label, n]) => (
                <div key={label} className="rounded-lg border border-border p-4 text-center">
                  <div className="text-2xl font-serif text-primary">{n}</div>
                  <div className="text-xs text-muted-foreground mt-1">{label}</div>
                </div>
              ))}
            </div>
            <div className="flex gap-3">
              <Button onClick={runImport} disabled={importFile.isPending} className="gap-2">
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
