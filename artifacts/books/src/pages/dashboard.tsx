import { useCurrentOrg } from "@/hooks/use-current-org";
import { useGetOrgDashboard, getGetOrgDashboardQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { format } from "date-fns";
import { CheckCircle2, AlertTriangle, ArrowUpRight, ArrowDownRight } from "lucide-react";

export default function Dashboard() {
  const { orgId } = useCurrentOrg();
  const { data: dashboard, isLoading } = useGetOrgDashboard(orgId || "", {
    query: {
      enabled: !!orgId,
      queryKey: getGetOrgDashboardQueryKey(orgId || ""),
    },
  });

  if (!orgId) return null;

  if (isLoading || !dashboard) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="w-8 h-8 text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Overview</h1>
        <p className="text-muted-foreground mt-1">Here's how your business is doing.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription>Cash on Hand</CardDescription>
            <CardTitle className="text-3xl font-serif">${dashboard.cash}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Available in your accounts</p>
          </CardContent>
        </Card>
        
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription>Net Income</CardDescription>
            <CardTitle className="text-3xl font-serif">${dashboard.netIncome}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Profit this period</p>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <div>
              <CardDescription>Ledger Status</CardDescription>
              <CardTitle className="text-xl mt-1">
                {dashboard.balanced ? "Balanced" : "Out of Balance"}
              </CardTitle>
            </div>
            {dashboard.balanced ? (
              <CheckCircle2 className="w-8 h-8 text-green-600" />
            ) : (
              <AlertTriangle className="w-8 h-8 text-destructive" />
            )}
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {dashboard.balanced ? "Everything adds up" : `Difference: $${dashboard.difference}`}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl">Recent Activity</CardTitle>
            <CardDescription>Your latest transactions</CardDescription>
          </CardHeader>
          <CardContent>
            {dashboard.recentActivity.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground text-sm">
                No recent activity.
              </div>
            ) : (
              <div className="space-y-4">
                {dashboard.recentActivity.map((entry) => {
                  const isPositive = !entry.amount.startsWith("-");
                  return (
                    <div key={entry.id} className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-full ${isPositive ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                          {isPositive ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />}
                        </div>
                        <div>
                          <p className="text-sm font-medium">{entry.memo || "Transaction"}</p>
                          <p className="text-xs text-muted-foreground">
                            {format(new Date(entry.entryDate), "MMM d, yyyy")}
                          </p>
                        </div>
                      </div>
                      <div className={`text-sm font-medium ${isPositive ? "text-green-700" : "text-red-700"}`}>
                        {isPositive ? "+" : "-"}${entry.amount.replace("-", "")}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
