import { useState, useMemo } from "react";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { 
  useGetOrgDashboard, 
  getGetOrgDashboardQueryKey,
  useGetMyCloseStatus,
  getGetMyCloseStatusQueryKey,
  useRespondPbcRequest,
  useGetProfitAndLossReport,
  getGetProfitAndLossReportQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { format } from "date-fns";
import { CheckCircle2, AlertTriangle, ArrowUpRight, ArrowDownRight, ClipboardList, Check, Clock, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { CHART_CATEGORICAL } from "@/lib/brand";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, PieChart, Pie, Cell as PieCell } from 'recharts';

const leafName = (name: string) => {
  const parts = name.split(":");
  return parts[parts.length - 1].trim();
};

const truncate = (s: string, max = 20) => (s.length > max ? s.slice(0, max - 1) + "\u2026" : s);

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

  // Fetch P&L to show charts
  const { data: pnl } = useGetProfitAndLossReport(orgId || "", {
    query: { enabled: !!orgId, queryKey: getGetProfitAndLossReportQueryKey(orgId || "") }
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

  // Prepare chart data from P&L
  const pnlExpenseData = useMemo(() => {
    if (!pnl || !pnl.expenses) return [];
    return pnl.expenses
      .filter(item => parseFloat(item.amount) > 0)
      .sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount))
      .slice(0, 5) // top 5
      .map(item => ({
        name: truncate(leafName(item.name)),
        fullName: item.name,
        amount: item.amount,
        value: parseFloat(item.amount),
      }));
  }, [pnl]);

  const pnlRevenueData = useMemo(() => {
    if (!pnl || !pnl.revenue) return [];
    return pnl.revenue
      .filter(item => parseFloat(item.amount) > 0)
      .map(item => ({
        name: truncate(leafName(item.name), 26),
        fullName: item.name,
        amount: item.amount,
        value: parseFloat(item.amount),
      }));
  }, [pnl]);

  const COLORS = CHART_CATEGORICAL;

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
        <h1 className="text-3xl font-serif font-semibold tracking-tight text-foreground">Command Center</h1>
        <p className="text-muted-foreground mt-1">Live financial status and outstanding items.</p>
      </div>

      {/* KPI Row */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="shadow-none border-border bg-card">
          <CardHeader className="pb-2">
            <CardDescription className="uppercase tracking-widest text-[10px] font-bold text-muted-foreground">Cash on Hand</CardDescription>
            <CardTitle className="text-3xl font-mono text-foreground">${dashboard.cash}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">Available liquidity</p>
          </CardContent>
        </Card>
        
        <Card className="shadow-none border-border bg-card">
          <CardHeader className="pb-2">
            <CardDescription className="uppercase tracking-widest text-[10px] font-bold text-muted-foreground">Net Income</CardDescription>
            <CardTitle className="text-3xl font-mono text-foreground">${dashboard.netIncome}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">Profit this period</p>
          </CardContent>
        </Card>

        <Card className={`shadow-none border ${dashboard.balanced ? "border-[#3CB54A]/30 bg-[#3CB54A]/5" : "border-destructive/30 bg-destructive/5"}`}>
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <div>
              <CardDescription className={`uppercase tracking-widest text-[10px] font-bold ${dashboard.balanced ? "text-[#3CB54A]" : "text-destructive"}`}>Ledger Status</CardDescription>
              <CardTitle className={`text-xl mt-1 font-semibold ${dashboard.balanced ? "text-[#3CB54A]" : "text-destructive"}`}>
                {dashboard.balanced ? "Balanced" : "Out of Balance"}
              </CardTitle>
            </div>
            {dashboard.balanced ? (
              <CheckCircle2 className="w-8 h-8 text-[#3CB54A]" />
            ) : (
              <AlertTriangle className="w-8 h-8 text-destructive" />
            )}
          </CardHeader>
          <CardContent>
            <p className={`text-sm ${dashboard.balanced ? "text-[#3CB54A]/80" : "text-destructive/80"}`}>
              {dashboard.balanced ? "All accounts reconciled" : `Difference: $${dashboard.difference}`}
            </p>
          </CardContent>
        </Card>
        
        {hasCloseData ? (
          <Card className="shadow-none bg-accent/20 border-primary/20">
            <CardHeader className="pb-2">
              <CardDescription className="text-primary font-bold text-[10px] tracking-widest uppercase flex items-center gap-1">
                <ClipboardList className="w-3 h-3" /> Period Close
              </CardDescription>
              <CardTitle className="text-xl mt-1">
                {closeStatus?.summary?.period.period}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-muted-foreground">Status</span>
                <Badge variant="outline" className="bg-background text-[10px] font-mono border-border uppercase">
                  {closeStatus?.summary?.period.status?.replace('_', ' ')}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Action Needed</span>
                <span className={`font-semibold text-sm ${requestedPbcs.length > 0 ? 'text-primary' : 'text-[#3CB54A]'}`}>
                  {requestedPbcs.length} items
                </span>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="shadow-none border-border bg-card/50 flex flex-col justify-center items-center text-center p-6">
             <div className="w-10 h-10 rounded-full bg-accent/50 flex items-center justify-center mb-3">
               <TrendingUp className="w-5 h-5 text-muted-foreground" />
             </div>
             <p className="text-sm font-medium text-muted-foreground">No active close period</p>
          </Card>
        )}
      </div>

      {/* Charts Row */}
      {pnl && (
        <div className="grid gap-4 md:grid-cols-5">
          <Card className="shadow-none border-border bg-card md:col-span-3">
            <CardHeader className="pb-2 flex flex-row items-baseline justify-between space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Top Expenses</CardTitle>
              <span className="text-xs font-mono text-muted-foreground">Total ${pnl.totalExpenses}</span>
            </CardHeader>
            <CardContent>
              {pnlExpenseData.length > 0 ? (
                <div className="h-[240px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={pnlExpenseData} layout="vertical" margin={{ top: 5, right: 24, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#1E2126" />
                      <XAxis type="number" tickFormatter={(val) => `$${val}`} stroke="#B8C0C8" fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis
                        dataKey="name"
                        type="category"
                        width={140}
                        stroke="#B8C0C8"
                        fontSize={12}
                        tickLine={false}
                        axisLine={false}
                        interval={0}
                      />
                      <Tooltip
                        cursor={{fill: '#1E2126'}}
                        contentStyle={{backgroundColor: '#16181C', borderColor: '#1E2126', color: '#E8EAED', borderRadius: '6px'}}
                        itemStyle={{color: '#1E90FF'}}
                        labelFormatter={(_label, payload) => payload?.[0]?.payload?.fullName ?? _label}
                        formatter={(_value: number, _name, entry) => [`$${entry?.payload?.amount}`, 'Expense']}
                      />
                      <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={22}>
                        {pnlExpenseData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-[240px] flex items-center justify-center text-muted-foreground text-sm">No expense data</div>
              )}
            </CardContent>
          </Card>

          <Card className="shadow-none border-border bg-card md:col-span-2">
            <CardHeader className="pb-2 flex flex-row items-baseline justify-between space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Revenue Breakdown</CardTitle>
              <span className="text-xs font-mono text-muted-foreground">Total ${pnl.totalRevenue}</span>
            </CardHeader>
            <CardContent>
              {pnlRevenueData.length > 0 ? (
                <div className="h-[240px] w-full flex items-center gap-2">
                  <div className="h-full flex-1 min-w-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={pnlRevenueData}
                          cx="50%"
                          cy="50%"
                          innerRadius={55}
                          outerRadius={85}
                          paddingAngle={2}
                          dataKey="value"
                          stroke="none"
                        >
                          {pnlRevenueData.map((entry, index) => (
                            <PieCell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{backgroundColor: '#16181C', borderColor: '#1E2126', color: '#E8EAED', borderRadius: '6px'}}
                          itemStyle={{color: '#3CB54A'}}
                          labelFormatter={(_label, payload) => payload?.[0]?.payload?.fullName ?? _label}
                          formatter={(_value: number, _name, entry) => [`$${entry?.payload?.amount}`, 'Revenue']}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="w-[45%] max-h-full overflow-y-auto space-y-2 pr-1" data-testid="legend-revenue-breakdown">
                    {pnlRevenueData.map((entry, index) => (
                      <li key={entry.fullName} className="flex items-center justify-between gap-2 text-xs" title={entry.fullName}>
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                          <span className="truncate text-muted-foreground">{entry.name}</span>
                        </span>
                        <span className="font-mono text-foreground shrink-0">${entry.amount}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="h-[240px] flex items-center justify-center text-muted-foreground text-sm">No revenue data</div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Activity & Requests Row */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-6">
          <Card className="shadow-none border-border bg-card">
            <CardHeader>
              <CardTitle className="text-lg">Recent Ledger Activity</CardTitle>
              <CardDescription>Latest transactions recorded</CardDescription>
            </CardHeader>
            <CardContent>
              {dashboard.recentActivity.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground text-sm bg-accent/30 rounded-md border border-border border-dashed">
                  No recent activity found.
                </div>
              ) : (
                <div className="space-y-4">
                  {dashboard.recentActivity.map((entry) => {
                    const isPositive = !entry.amount.startsWith("-");
                    return (
                      <div key={entry.id} className="flex items-center justify-between p-2 rounded hover:bg-accent/50 transition-colors">
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-md ${isPositive ? "bg-[#3CB54A]/10 text-[#3CB54A]" : "bg-destructive/10 text-destructive"}`}>
                            {isPositive ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />}
                          </div>
                          <div>
                            <p className="text-sm font-medium">{entry.memo || "Transaction"}</p>
                            <p className="text-xs text-muted-foreground">
                              {format(new Date(entry.entryDate), "MMM d, yyyy")}
                            </p>
                          </div>
                        </div>
                        <div className={`text-sm font-mono font-medium ${isPositive ? "text-[#3CB54A]" : "text-destructive"}`}>
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
            <Card className="shadow-none border-primary/20 bg-card">
              <CardHeader className="bg-primary/5 pb-4 border-b border-border">
                <CardTitle className="text-lg flex items-center gap-2 text-primary">
                  <ClipboardList className="w-5 h-5" />
                  Action Required
                </CardTitle>
                <CardDescription>
                  Your accountant requested input for {closeStatus?.summary?.period.period}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-6">
                {(closeStatus?.summary?.pbc.items.length ?? 0) === 0 ? (
                  <div className="text-center py-8 text-muted-foreground flex flex-col items-center bg-accent/30 rounded-md border border-border border-dashed">
                    <CheckCircle2 className="w-8 h-8 text-[#3CB54A] mb-2 opacity-80" />
                    <p className="text-sm">No open requests from your accountant.</p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {closeStatus?.summary?.pbc.items.map(req => (
                      <div key={req.id} className="border border-border rounded-md overflow-hidden bg-background">
                        <div className="bg-accent/50 p-4 border-b border-border">
                          <div className="flex justify-between items-start mb-2">
                            <h4 className="font-semibold text-sm">{req.title}</h4>
                            <Badge variant={
                              req.status === 'requested' ? 'default' : 
                              req.status === 'provided' ? 'secondary' : 'outline'
                            } className={req.status === 'requested' ? "bg-primary" : "bg-transparent border-border"}>
                              {req.status}
                            </Badge>
                          </div>
                          {req.detail && <p className="text-xs text-muted-foreground">{req.detail}</p>}
                        </div>
                        
                        <div className="p-4">
                          {req.status === 'requested' ? (
                            <div className="space-y-3">
                              <Textarea 
                                placeholder="Type your response here..."
                                value={responses[req.id] || ""}
                                onChange={(e) => setResponses(prev => ({...prev, [req.id]: e.target.value}))}
                                className="min-h-[80px] bg-input/50 text-sm focus:border-primary"
                              />
                              <div className="flex justify-end">
                                <Button 
                                  size="sm" 
                                  onClick={() => handleRespond(req.id)}
                                  disabled={!responses[req.id]?.trim() || respondPbc.isPending}
                                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                                >
                                  {respondPbc.isPending && responses[req.id] !== undefined ? <Spinner className="mr-2 w-3 h-3" /> : null}
                                  Submit Response
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="bg-accent/30 p-3 rounded text-sm border border-border/50">
                              <span className="font-medium text-muted-foreground block mb-1 text-xs uppercase tracking-wider">Your Response</span>
                              {req.response}
                              {req.status === 'provided' && (
                                <div className="mt-3 flex items-center text-primary text-xs font-medium">
                                  <Clock className="w-3 h-3 mr-1" /> Pending review
                                </div>
                              )}
                              {req.status === 'accepted' && (
                                <div className="mt-3 flex items-center text-[#3CB54A] text-xs font-medium">
                                  <Check className="w-3 h-3 mr-1" /> Accepted
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
