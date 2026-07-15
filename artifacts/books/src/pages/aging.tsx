import { useCurrentOrg } from "@/hooks/use-current-org";
import { useGetArAging, getGetArAgingQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { PieChart } from "lucide-react";

const BUCKET_LABELS: Record<string, string> = {
  current: "Current",
  "1-30": "1–30 days",
  "31-60": "31–60 days",
  "61-90": "61–90 days",
  "90+": "90+ days",
};

const BUCKET_ORDER = ["current", "1-30", "31-60", "61-90", "90+"] as const;

function badgeVariant(bucket: string): "default" | "secondary" | "outline" | "destructive" {
  if (bucket === "current") return "secondary";
  if (bucket === "90+" || bucket === "61-90") return "destructive";
  return "outline";
}

export default function Aging() {
  const { orgId } = useCurrentOrg();

  const { data, isLoading } = useGetArAging(
    orgId || "",
    undefined,
    { query: { enabled: !!orgId, queryKey: getGetArAgingQueryKey(orgId || "") } },
  );

  if (!orgId) return null;
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="w-8 h-8 text-primary" />
      </div>
    );
  }

  const buckets = data?.buckets;
  const lines = data?.lines || [];

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div>
        <h1 className="text-3xl font-serif font-semibold tracking-tight text-foreground">A/R Aging</h1>
        <p className="text-muted-foreground mt-1">
          Outstanding receivables as of {data ? format(new Date(data.asOf), "MMM d, yyyy") : "today"}.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {BUCKET_ORDER.map((key) => (
          <Card key={key} className="shadow-none border-border bg-card">
            <CardContent className="p-4 text-center">
              <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wider font-semibold">{BUCKET_LABELS[key]}</div>
              <div className={`text-xl font-mono ${key === "current" ? "text-foreground" : key === "90+" || key === "61-90" ? "text-destructive" : "text-[#B8C0C8]"}`}>
                ${buckets ? buckets[key] : "0.00"}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="shadow-none border-border bg-card">
        <CardHeader className="flex flex-row items-center justify-between border-b border-border bg-accent/30 pb-4">
          <CardTitle>Outstanding Invoices</CardTitle>
          <div className="text-right">
            <div className="text-xs text-muted-foreground uppercase tracking-widest font-semibold">Total Outstanding</div>
            <div className="font-serif text-xl text-primary">${data?.total ?? "0.00"}</div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {lines.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground bg-accent/20 m-6 rounded-md border border-border border-dashed">
              <PieChart className="w-12 h-12 mx-auto mb-3 opacity-40 text-[#3CB54A]" />
              <p className="text-lg font-medium text-foreground mb-1">No outstanding receivables.</p>
              <p className="text-sm">All invoices are paid. You're fully caught up.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground bg-accent/20">
                    <th className="py-3 px-6 font-semibold uppercase tracking-wider text-xs">Customer</th>
                    <th className="py-3 px-4 font-semibold uppercase tracking-wider text-xs">Invoice</th>
                    <th className="py-3 px-4 font-semibold uppercase tracking-wider text-xs">Due</th>
                    <th className="py-3 px-4 font-semibold uppercase tracking-wider text-xs text-right">Days Past Due</th>
                    <th className="py-3 px-4 font-semibold uppercase tracking-wider text-xs">Bucket</th>
                    <th className="py-3 px-6 font-semibold uppercase tracking-wider text-xs text-right">Outstanding</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {lines.map((l) => (
                    <tr key={l.invoiceId} className="hover:bg-accent/30 transition-colors bg-background">
                      <td className="py-3 px-6 font-medium text-foreground">{l.customer}</td>
                      <td className="py-3 px-4 font-mono text-xs text-muted-foreground">{l.invoiceNumber || "—"}</td>
                      <td className="py-3 px-4 text-muted-foreground font-mono text-xs">
                        {format(new Date(l.dueDate), "MMM d, yyyy")}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-xs">{l.daysPastDue}</td>
                      <td className="py-3 px-4">
                        <Badge 
                          variant={badgeVariant(l.bucket)}
                          className={`text-[10px] uppercase tracking-wider font-bold ${
                            l.bucket === 'current' ? 'bg-accent text-muted-foreground border-transparent' : 
                            l.bucket === '90+' || l.bucket === '61-90' ? 'bg-destructive/20 text-destructive border-transparent' :
                            'bg-transparent text-muted-foreground border-border'
                          }`}
                        >
                          {BUCKET_LABELS[l.bucket] ?? l.bucket}
                        </Badge>
                      </td>
                      <td className="py-3 px-6 text-right font-mono text-foreground">${l.outstanding}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
