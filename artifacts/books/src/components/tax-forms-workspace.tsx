import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReviewTaxForms, type TaxDraftReview, type TaxDraftInput } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const YEARS = [2024, 2025, 2026];
const LINES = ["8", "10", "11", "15", "16a", "16b", "17", "18", "20a", "20b", "21", "22", "23", "24a", "24b", "25", "26", "other"];
const NEC_LABEL = "Potential 1099 recipients \u2014 review required";
type Kind = "nec" | "schedule-c" | "sales-tax";

function errMsg(err: unknown, fallback: string): { status?: number; message: string } {
  const e = err as { status?: number; data?: { error?: string } | null };
  return { status: e?.status, message: e?.data?.error || fallback };
}

function Ids({ label, ids }: { label: string; ids: string[] }) {
  if (!ids.length) return null;
  return (
    <div className="text-[11px] text-muted-foreground font-mono break-all">
      {label}: {ids.join(", ")}
    </div>
  );
}

function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="text-xs text-amber-500 space-y-0.5" data-testid="list-warnings">
      {items.map((w, i) => <li key={i}>Flag: {w}</li>)}
    </ul>
  );
}

export function TaxFormsWorkspace({ orgId }: { orgId: string }) {
  const [year, setYear] = useState(2025);
  const [review, setReview] = useState<TaxDraftReview | null>(null);
  const [error, setError] = useState<{ status?: number; message: string } | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [eligibility, setEligibility] = useState<Record<string, [boolean, boolean, boolean]>>({});
  const [vendor, setVendor] = useState<string | null>(null);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [salesIds, setSalesIds] = useState<Set<string>>(new Set());
  const [taxIds, setTaxIds] = useState<Set<string>>(new Set());
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<Kind | null>(null);
  const [dlError, setDlError] = useState<string | null>(null);
  const [showBelow, setShowBelow] = useState(false);
  const scope = useRef("");
  const reviewMut = useReviewTaxForms();
  const mutateRef = useRef(reviewMut.mutate);
  mutateRef.current = reviewMut.mutate;

  const load = useCallback((o: string, y: number) => {
    const key = `${o}:${y}`;
    scope.current = key;
    setReview(null); setError(null); setConfirmed(new Set()); setEligibility({}); setVendor(null);
    setMappings({}); setSalesIds(new Set()); setTaxIds(new Set()); setAck(false); setDlError(null);
    mutateRef.current({ orgId: o, data: { year: y } }, {
      onSuccess: (r) => { if (scope.current === key) setReview(r); },
      onError: (e) => { if (scope.current === key) setError(errMsg(e, "Could not load the ledger review.")); },
    });
  }, []);

  useEffect(() => { load(orgId, year); }, [orgId, year, load]);
  useEffect(() => { setAck(false); }, [confirmed, eligibility, vendor, mappings, salesIds, taxIds]);

  const loading = !review && !error;
  const revenue = useMemo(() => review?.accounts.filter((a) => a.type === "revenue") ?? [], [review]);
  const liabilities = useMemo(() => review?.accounts.filter((a) => a.type === "liability") ?? [], [review]);
  const expenses = useMemo(() => review?.accounts.filter((a) => a.type === "expense") ?? [], [review]);

  const toggle = (set: Set<string>, id: string, fn: (s: Set<string>) => void) => {
    const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); fn(n);
  };

  const setElig = (id: string, i: number, v: boolean) => {
    const cur = eligibility[id] ?? [false, false, false];
    const next = [...cur] as [boolean, boolean, boolean]; next[i] = v;
    setEligibility({ ...eligibility, [id]: next });
    if (!next.every(Boolean) && confirmed.has(id)) { const c = new Set(confirmed); c.delete(id); setConfirmed(c); }
  };

  const download = async (kind: Kind) => {
    if (!review) return;
    setBusy(kind); setDlError(null);
    const key = scope.current;
    const body: TaxDraftInput = {
      year: review.year, kind, vendor: kind === "nec" ? vendor ?? "" : "",
      confirmedPaymentIds: kind === "nec" ? [...confirmed] : [],
      mappings: kind === "schedule-c" ? Object.entries(mappings).filter(([, l]) => l).map(([accountId, line]) => ({ accountId, line })) : [],
      salesAccountIds: kind === "sales-tax" ? [...salesIds] : [],
      salesTaxAccountIds: kind === "sales-tax" ? [...taxIds] : [],
      acknowledged: true, sourceDigest: review.sourceDigest,
    };
    try {
      const res = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/orgs/${orgId}/tax-forms/pdf`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (scope.current !== key) return;
      if (!res.ok) {
        let m = "Download failed.";
        try { m = (await res.json()).error || m; } catch { /* ignore */ }
        if (res.status === 409) { load(orgId, year); setDlError(`${m} The review was refetched and your selections were cleared.`); }
        else if (res.status === 403) setDlError("Only organization owners can download tax drafts.");
        else setDlError(m);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `draft-${kind}-${review.year}.pdf`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch {
      if (scope.current === key) setDlError("Network error while generating the draft.");
    } finally { setBusy((b) => (b === kind ? null : b)); }
  };

  const AckBlock = ({ kind, ready, hint }: { kind: Kind; ready: boolean; hint: string }) => (
    <div className="border border-border rounded-md p-4 space-y-3 bg-accent/20">
      <label className="flex gap-3 items-start text-sm cursor-pointer">
        <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} data-testid={`checkbox-ack-${kind}`} />
        <span>I am an owner and have reviewed the ledger and the missing-data warnings above. I understand this draft is not tax advice.</span>
      </label>
      {dlError && <p className="text-sm text-destructive" data-testid="text-download-error">{dlError}</p>}
      <div className="flex items-center gap-3 flex-wrap">
        <Button disabled={!ack || !ready || busy !== null} onClick={() => download(kind)} data-testid={`button-download-${kind}`}>
          {busy === kind ? "Generating..." : "Download draft PDF"}
        </Button>
        {!ready && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Tax Forms</h1>
          <p className="text-muted-foreground mt-1">Ledger-only draft documents with every figure traced to its source.</p>
        </div>
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger className="w-32" data-testid="select-tax-year"><SelectValue /></SelectTrigger>
          <SelectContent>{YEARS.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <Alert data-testid="alert-transient">
        <AlertTitle>Selections are temporary</AlertTitle>
        <AlertDescription>
          Nothing here is saved. Your confirmations and mappings reset when you reload the page or change the organization or year.
          No taxpayer ID or address is collected; missing identity fields are left blank and flagged in the PDF.
          This tool does not compute tax owed, e-file, or handle depreciation.
        </AlertDescription>
      </Alert>

      {loading && <div className="space-y-3" data-testid="state-loading"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>}

      {error && (
        <Alert variant="destructive" data-testid="state-error">
          <AlertTitle>{error.status === 403 ? "Owner access required" : "Review failed"}</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{error.status === 403 ? "Tax draft documents can only be reviewed by organization owners. Ask an owner to open this page." : error.message}</p>
            {error.status !== 403 && <Button size="sm" variant="outline" onClick={() => load(orgId, year)} data-testid="button-retry">Retry</Button>}
          </AlertDescription>
        </Alert>
      )}

      {review && (
        <>
          <Card className="shadow-none border-border bg-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{review.orgName} &middot; {review.year} &middot; {review.currency}</CardTitle>
              <CardDescription className="font-mono text-[11px] break-all" data-testid="text-digest">Source digest {review.sourceDigest}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p data-testid="text-disclaimer">{review.disclaimer}</p>
              {review.unresolvedEntries > 0 && (
                <p className="text-amber-500" data-testid="text-unresolved">{review.unresolvedEntries} ledger entries are unresolved and may be missing from these drafts.</p>
              )}
              <Warnings items={review.warnings} />
            </CardContent>
          </Card>

          <Tabs defaultValue="nec">
            <TabsList>
              <TabsTrigger value="nec" data-testid="tab-nec">1099-NEC</TabsTrigger>
              <TabsTrigger value="schedule-c" data-testid="tab-schedule-c">Schedule C</TabsTrigger>
              <TabsTrigger value="sales-tax" data-testid="tab-sales-tax">Sales tax</TabsTrigger>
            </TabsList>

            <TabsContent value="nec" className="space-y-4 mt-4">
              <h2 className="text-lg font-serif" data-testid="heading-nec">{NEC_LABEL}</h2>
              <p className="text-sm text-muted-foreground">Threshold for {review.year}: {review.currency} {review.threshold}. One vendor per document. Confirm each payment individually.</p>
              {review.candidates.length === 0 && <div className="border border-dashed border-border rounded-md p-8 text-center text-sm text-muted-foreground" data-testid="empty-nec">No vendor payments were found in the ledger for {review.year}.</div>}
              {review.candidates.some((c) => !c.aboveThreshold) && (
                <Button variant="outline" size="sm" onClick={() => setShowBelow(!showBelow)} data-testid="button-toggle-below">
                  {showBelow ? "Hide" : "Review"} vendors below threshold
                </Button>
              )}
              {review.candidates.filter((c) => c.aboveThreshold || showBelow).map((c) => {
                const selected = vendor === c.vendor;
                return (
                  <Card key={c.vendor} className={`shadow-none bg-card ${selected ? "border-primary/60" : "border-border"}`} data-testid={`card-vendor-${c.vendor}`}>
                    <CardHeader className="pb-3 flex-row items-center justify-between gap-3 space-y-0">
                      <div>
                        <CardTitle className="text-base">{c.vendor}</CardTitle>
                        <CardDescription>Recorded payments {c.total} &middot; included amounts are revalidated on download</CardDescription>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={c.aboveThreshold ? "default" : "secondary"}>{c.aboveThreshold ? "Above threshold" : "Below threshold"}</Badge>
                        <Button size="sm" variant={selected ? "default" : "outline"} data-testid={`button-select-vendor-${c.vendor}`}
                          onClick={() => { if (selected) setVendor(null); else { setVendor(c.vendor); setConfirmed(new Set()); setEligibility({}); } }}>
                          {selected ? "Selected" : "Select"}
                        </Button>
                      </div>
                    </CardHeader>
                    {selected && (
                      <CardContent className="space-y-3">
                        {c.payments.map((p) => {
                          const el = eligibility[p.id] ?? [false, false, false];
                          const labels = ["Service contractor payment", "Not card or network reportable", "No duplicate or reversed amount"];
                          return (
                            <div key={p.id} className="border border-border rounded-md p-3 space-y-2" data-testid={`row-payment-${p.id}`}>
                              <div className="flex justify-between text-sm"><span>{p.date} &middot; {p.accountName}</span><span className="font-mono">{review.currency} {p.amount}</span></div>
                              <Ids label="Payment" ids={[p.id]} />
                              <Ids label="Entry" ids={[p.entryId]} />
                              <Warnings items={p.warnings} />
                              <div className="grid sm:grid-cols-3 gap-2">
                                {labels.map((l, i) => (
                                  <label key={l} className="flex gap-2 items-start text-xs cursor-pointer">
                                    <Checkbox checked={el[i]} onCheckedChange={(v) => setElig(p.id, i, v === true)} data-testid={`checkbox-elig-${i}-${p.id}`} />{l}
                                  </label>
                                ))}
                              </div>
                              <label className="flex gap-2 items-center text-sm font-medium cursor-pointer">
                                <Checkbox disabled={!el.every(Boolean)} checked={confirmed.has(p.id)} onCheckedChange={() => toggle(confirmed, p.id, setConfirmed)} data-testid={`checkbox-confirm-${p.id}`} />
                                Include this payment
                              </label>
                            </div>
                          );
                        })}
                      </CardContent>
                    )}
                  </Card>
                );
              })}
              <AckBlock kind="nec" ready={!!vendor && confirmed.size > 0} hint="Select a vendor and confirm at least one payment." />
            </TabsContent>

            <TabsContent value="schedule-c" className="space-y-4 mt-4">
              <h2 className="text-lg font-serif">Schedule C expense mapping</h2>
              <p className="text-sm text-muted-foreground">Choose the Schedule C line for each expense account. Amounts come from the ledger and cannot be edited.</p>
              {expenses.length === 0 ? (
                <div className="border border-dashed border-border rounded-md p-8 text-center text-sm text-muted-foreground" data-testid="empty-schedule-c">No expense accounts with activity in {review.year}. Schedule C is unavailable.</div>
              ) : expenses.map((a) => (
                <div key={a.id} className="border border-border rounded-md p-3 flex flex-wrap items-center justify-between gap-3" data-testid={`row-account-${a.id}`}>
                  <div className="space-y-1 min-w-0">
                    <div className="text-sm font-medium">{a.code} {a.name}</div>
                    <div className="text-xs text-muted-foreground font-mono">Amount {a.amount} (debits {a.debits}, credits {a.credits})</div>
                    <Ids label="Account" ids={[a.id]} />
                    <Ids label="Entries" ids={a.entryIds} />
                  </div>
                  <Select value={mappings[a.id] ?? "none"} onValueChange={(v) => { const m = { ...mappings }; if (v === "none") delete m[a.id]; else m[a.id] = v; setMappings(m); }}>
                    <SelectTrigger className="w-40" data-testid={`select-line-${a.id}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not mapped</SelectItem>
                      {LINES.map((l) => <SelectItem key={l} value={l}>{l === "other" ? "Other expenses" : `Line ${l}`}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
              <AckBlock kind="schedule-c" ready={Object.keys(mappings).length > 0} hint="Map at least one account to a line." />
            </TabsContent>

            <TabsContent value="sales-tax" className="space-y-4 mt-4">
              <h2 className="text-lg font-serif">Sales tax worksheet</h2>
              <p className="text-sm text-muted-foreground">Liability figures are recorded ledger movements, not tax owed.</p>
              {revenue.length === 0 || liabilities.length === 0 ? (
                <div className="border border-dashed border-border rounded-md p-8 text-center text-sm text-muted-foreground" data-testid="empty-sales-tax">
                  Unavailable: this worksheet needs at least one revenue account and one liability account with activity in {review.year}.
                </div>
              ) : (
                <div className="grid md:grid-cols-2 gap-4">
                  {([["Revenue accounts (sales)", revenue, salesIds, setSalesIds, "sales"], ["Liability accounts (sales tax collected)", liabilities, taxIds, setTaxIds, "tax"]] as const).map(([title, list, sel, setSel, k]) => (
                    <div key={k} className="space-y-2">
                      <h3 className="text-sm font-medium">{title}</h3>
                      {list.map((a) => (
                        <label key={a.id} className="flex gap-3 items-start border border-border rounded-md p-3 cursor-pointer" data-testid={`row-${k}-${a.id}`}>
                          <Checkbox checked={sel.has(a.id)} onCheckedChange={() => toggle(sel, a.id, setSel)} data-testid={`checkbox-${k}-${a.id}`} />
                          <span className="space-y-1 min-w-0">
                            <span className="block text-sm">{a.code} {a.name}</span>
                            <span className="block text-xs text-muted-foreground font-mono">Movement {a.amount} (debits {a.debits}, credits {a.credits})</span>
                            <Ids label="Account" ids={[a.id]} />
                            <Ids label="Entries" ids={a.entryIds} />
                          </span>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              <AckBlock kind="sales-tax" ready={salesIds.size > 0 && taxIds.size > 0} hint="Select at least one revenue and one liability account." />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
