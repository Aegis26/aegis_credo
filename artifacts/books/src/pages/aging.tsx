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
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">A/R Aging</h1>
        <p className="text-muted-foreground mt-1">
          Outstanding receivables as of {data ? format(new Date(data.asOf), "MMM d, yyyy") : "today"}.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {BUCKET_ORDER.map((key) => (
          <Card key={key} className="shadow-sm border-border">
            <CardContent className="p-4 text-center">
              <div className="text-xs text-muted-foreground mb-1">{BUCKET_LABELS[key]}</div>
              <div className="text-xl font-serif text-primary">
                ${buckets ? buckets[key] : "0.00"}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="shadow-sm border-border">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Outstanding invoices</CardTitle>
          <div className="text-right">
            <div className="text-xs text-muted-foreground">Total outstanding</div>
            <div className="font-serif text-lg text-primary">${data?.total ?? "0.00"}</div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {lines.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <PieChart className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p>No outstanding receivables. You're all caught up.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-3 px-6 font-medium">Customer</th>
                    <th className="py-3 px-4 font-medium">Invoice</th>
                    <th className="py-3 px-4 font-medium">Due</th>
                    <th className="py-3 px-4 font-medium text-right">Days past due</th>
                    <th className="py-3 px-4 font-medium">Bucket</th>
                    <th className="py-3 px-6 font-medium text-right">Outstanding</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {lines.map((l) => (
                    <tr key={l.invoiceId} className="hover:bg-muted/30 transition-colors">
                      <td className="py-3 px-6 font-medium">{l.customer}</td>
                      <td className="py-3 px-4 text-muted-foreground">{l.invoiceNumber || "—"}</td>
                      <td className="py-3 px-4 text-muted-foreground">
                        {format(new Date(l.dueDate), "MMM d, yyyy")}
                      </td>
                      <td className="py-3 px-4 text-right">{l.daysPastDue}</td>
                      <td className="py-3 px-4">
                        <Badge variant={badgeVariant(l.bucket)}>{BUCKET_LABELS[l.bucket] ?? l.bucket}</Badge>
                      </td>
                      <td className="py-3 px-6 text-right font-mono">${l.outstanding}</td>
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
