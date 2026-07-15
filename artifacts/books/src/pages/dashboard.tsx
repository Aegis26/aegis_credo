import { useState } from "react";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { 
  useGetOrgDashboard, 
  getGetOrgDashboardQueryKey,
  useGetMyCloseStatus,
  getGetMyCloseStatusQueryKey,
  useRespondPbcRequest
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { format } from "date-fns";
import { CheckCircle2, AlertTriangle, ArrowUpRight, ArrowDownRight, ClipboardList, Check, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";

export default function Dashboard() {
  const { orgId } = useCurrentOrg();
  const queryClient = useQueryClient();
  
  const { data: dashboard, isLoading } = useGetOrgDashboard(orgId || "", {
    query: {
      enabled: !!orgId,
      queryKey: getGetOrgDashboardQueryKey(orgId || ""),
    },
  });

  const { data: closeStatus, isLoading: closeLoading } = useGetMyCloseStatus(orgId || "", {
    query: {
      enabled: !!orgId,
      queryKey: getGetMyCloseStatusQueryKey(orgId || "")
    }
  });

  const respondPbc = useRespondPbcRequest();
  const [responses, setResponses] = useState<Record<string, string>>({});

  const handleRespond = (requestId: string) => {
    if (!orgId || !responses[requestId]?.trim()) return;
    
    respondPbc.mutate({
      orgId,
      requestId,
      data: { response: responses[requestId] }
    }, {
      onSuccess: () => {
        setResponses(prev => {
          const next = { ...prev };
          delete next[requestId];
          return next;
        });
        queryClient.invalidateQueries({ queryKey: getGetMyCloseStatusQueryKey(orgId) });
      }
    });
  };

  if (!orgId) return null;

  if (isLoading || !dashboard || closeLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="w-8 h-8 text-primary" />
      </div>
    );
  }

  const requestedPbcs = closeStatus?.summary?.pbc.items.filter(p => p.status === 'requested') || [];
  const hasCloseData = closeStatus?.summary != null;

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
        
        {hasCloseData && (
          <Card className="shadow-sm bg-primary/5 border-primary/20">
            <CardHeader className="pb-2">
              <CardDescription className="text-primary/80 font-medium flex items-center gap-1">
                <ClipboardList className="w-4 h-4" /> Bookkeeping Close
              </CardDescription>
              <CardTitle className="text-xl mt-1">
                {closeStatus?.summary?.period.period}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm">Status</span>
                <Badge variant="outline" className="bg-white">{closeStatus?.summary?.period.status?.replace('_', ' ')}</Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Action Needed</span>
                <span className={`font-semibold ${requestedPbcs.length > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                  {requestedPbcs.length} items
                </span>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-6">
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

        {hasCloseData && (
          <div className="space-y-6">
            <Card className="shadow-sm border-primary/20">
              <CardHeader className="bg-primary/5 pb-4 border-b">
                <CardTitle className="text-xl flex items-center gap-2">
                  <ClipboardList className="w-5 h-5 text-primary" />
                  Accountant Requests
                </CardTitle>
                <CardDescription>
                  Your accountant needs information to close the books for {closeStatus?.summary?.period.period}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-6">
                {(closeStatus?.summary?.pbc.items.length ?? 0) === 0 ? (
                  <div className="text-center py-8 text-muted-foreground flex flex-col items-center">
                    <CheckCircle2 className="w-8 h-8 text-green-500 mb-2 opacity-50" />
                    <p>No open requests from your accountant.</p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {closeStatus?.summary?.pbc.items.map(req => (
                      <div key={req.id} className="border rounded-lg overflow-hidden">
                        <div className="bg-muted/30 p-4 border-b">
                          <div className="flex justify-between items-start mb-2">
                            <h4 className="font-semibold">{req.title}</h4>
                            <Badge variant={
                              req.status === 'requested' ? 'default' : 
                              req.status === 'provided' ? 'secondary' : 'outline'
                            }>
                              {req.status}
                            </Badge>
                          </div>
                          {req.detail && <p className="text-sm text-muted-foreground">{req.detail}</p>}
                        </div>
                        
                        <div className="p-4">
                          {req.status === 'requested' ? (
                            <div className="space-y-3">
                              <Textarea 
                                placeholder="Type your response here..."
                                value={responses[req.id] || ""}
                                onChange={(e) => setResponses(prev => ({...prev, [req.id]: e.target.value}))}
                                className="min-h-[80px]"
                              />
                              <div className="flex justify-end">
                                <Button 
                                  size="sm" 
                                  onClick={() => handleRespond(req.id)}
                                  disabled={!responses[req.id]?.trim() || respondPbc.isPending}
                                >
                                  {respondPbc.isPending && responses[req.id] !== undefined ? <Spinner className="mr-2" /> : null}
                                  Submit Response
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="bg-muted p-3 rounded-md text-sm">
                              <span className="font-medium text-muted-foreground block mb-1">Your Response:</span>
                              {req.response}
                              {req.status === 'provided' && (
                                <div className="mt-3 flex items-center text-amber-600 text-xs font-medium">
                                  <Clock className="w-3 h-3 mr-1" /> Pending accountant review
                                </div>
                              )}
                              {req.status === 'accepted' && (
                                <div className="mt-3 flex items-center text-green-600 text-xs font-medium">
                                  <Check className="w-3 h-3 mr-1" /> Accepted by accountant
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
