import { useCurrentOrg } from "@/hooks/use-current-org";
import { useListPayrollRuns, getListPayrollRunsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { Users } from "lucide-react";

export default function Payroll() {
  const { orgId } = useCurrentOrg();

  const { data, isLoading } = useListPayrollRuns(orgId || "", {
    query: { enabled: !!orgId, queryKey: getListPayrollRunsQueryKey(orgId || "") },
  });

  if (!orgId) return null;
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="w-8 h-8 text-primary" />
      </div>
    );
  }

  const runs = data?.payrollRuns || [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Payroll</h1>
        <p className="text-muted-foreground mt-1">
          Finished payroll runs ingested from your provider and posted to the ledger.
        </p>
      </div>

      <Card className="shadow-sm border-border">
        <CardHeader>
          <CardTitle>Payroll runs</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {runs.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Users className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p>No payroll runs recorded yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-3 px-6 font-medium">Pay date</th>
                    <th className="py-3 px-4 font-medium">Provider</th>
                    <th className="py-3 px-4 font-medium text-right">Gross</th>
                    <th className="py-3 px-4 font-medium text-right">Taxes</th>
                    <th className="py-3 px-6 font-medium text-right">Net</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {runs.map((run) => (
                    <tr key={run.id} className="hover:bg-muted/30 transition-colors">
                      <td className="py-3 px-6 font-medium">
                        {format(new Date(run.payDate), "MMM d, yyyy")}
                      </td>
                      <td className="py-3 px-4">
                        <Badge variant="outline" className="capitalize">{run.provider}</Badge>
                      </td>
                      <td className="py-3 px-4 text-right font-mono">${run.grossPay}</td>
                      <td className="py-3 px-4 text-right font-mono">${run.taxes}</td>
                      <td className="py-3 px-6 text-right font-mono font-medium">${run.netPay}</td>
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
