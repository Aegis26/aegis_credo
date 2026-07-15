import { useCurrentOrg } from "@/hooks/use-current-org";
import { 
  useGetProfitAndLossReport,
  useGetBalanceSheetReport,
  useGetTrialBalanceReport,
  getGetProfitAndLossReportQueryKey,
  getGetBalanceSheetReportQueryKey,
  getGetTrialBalanceReportQueryKey
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function Reports() {
  const { orgId } = useCurrentOrg();

  const { data: pnl, isLoading: pnlLoading } = useGetProfitAndLossReport(orgId || "", {
    query: { enabled: !!orgId, queryKey: getGetProfitAndLossReportQueryKey(orgId || "") }
  });

  const { data: bs, isLoading: bsLoading } = useGetBalanceSheetReport(orgId || "", {
    query: { enabled: !!orgId, queryKey: getGetBalanceSheetReportQueryKey(orgId || "") }
  });

  const { data: tb, isLoading: tbLoading } = useGetTrialBalanceReport(orgId || "", {
    query: { enabled: !!orgId, queryKey: getGetTrialBalanceReportQueryKey(orgId || "") }
  });

  if (!orgId) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-semibold tracking-tight text-foreground">Reports</h1>
        <p className="text-muted-foreground mt-1">Financial statements for your business.</p>
      </div>

      <Tabs defaultValue="pnl" className="w-full">
        <TabsList className="mb-4 bg-card border border-border">
          <TabsTrigger value="pnl" className="data-[state=active]:bg-accent data-[state=active]:text-primary">Profit & Loss</TabsTrigger>
          <TabsTrigger value="bs" className="data-[state=active]:bg-accent data-[state=active]:text-primary">Balance Sheet</TabsTrigger>
          <TabsTrigger value="tb" className="data-[state=active]:bg-accent data-[state=active]:text-primary">Trial Balance</TabsTrigger>
        </TabsList>

        <TabsContent value="pnl">
          <Card className="shadow-none border-border bg-card">
            <CardHeader className="border-b border-border bg-accent/30 pb-4">
              <CardTitle>Profit & Loss</CardTitle>
              <CardDescription>Income and expenses for the current period</CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              {pnlLoading ? (
                <div className="flex justify-center py-8"><Spinner /></div>
              ) : pnl ? (
                <div className="space-y-8">
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3 border-b border-border pb-2">Revenue</h3>
                    <div className="space-y-2">
                      {pnl.revenue.map((line) => (
                        <div key={line.accountId} className="flex justify-between text-sm py-1 px-2 rounded hover:bg-accent/50">
                          <span className="text-foreground">{line.name}</span>
                          <span className="font-mono">${line.amount}</span>
                        </div>
                      ))}
                      <div className="flex justify-between text-sm font-semibold pt-2 mt-2 border-t border-border px-2">
                        <span>Total Revenue</span>
                        <span className="font-mono">${pnl.totalRevenue}</span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3 border-b border-border pb-2">Expenses</h3>
                    <div className="space-y-2">
                      {pnl.expenses.map((line) => (
                        <div key={line.accountId} className="flex justify-between text-sm py-1 px-2 rounded hover:bg-accent/50">
                          <span className="text-foreground">{line.name}</span>
                          <span className="font-mono">${line.amount}</span>
                        </div>
                      ))}
                      <div className="flex justify-between text-sm font-semibold pt-2 mt-2 border-t border-border px-2">
                        <span>Total Expenses</span>
                        <span className="font-mono">${pnl.totalExpenses}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-between text-lg font-serif font-bold pt-4 border-t-2 border-border px-2">
                    <span>Net Income</span>
                    <span className={`font-mono ${pnl.netIncome.startsWith("-") ? "text-destructive" : "text-[#3CB54A]"}`}>
                      ${pnl.netIncome}
                    </span>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="bs">
          <Card className="shadow-none border-border bg-card">
            <CardHeader className="border-b border-border bg-accent/30 pb-4">
              <CardTitle>Balance Sheet</CardTitle>
              <CardDescription>Assets, liabilities, and equity</CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              {bsLoading ? (
                <div className="flex justify-center py-8"><Spinner /></div>
              ) : bs ? (
                <div className="space-y-8">
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3 border-b border-border pb-2">Assets</h3>
                    <div className="space-y-2">
                      {bs.assets.map((line) => (
                        <div key={line.accountId} className="flex justify-between text-sm py-1 px-2 rounded hover:bg-accent/50">
                          <span className="text-foreground">{line.name}</span>
                          <span className="font-mono">${line.amount}</span>
                        </div>
                      ))}
                      <div className="flex justify-between text-sm font-semibold pt-2 mt-2 border-t border-border px-2">
                        <span>Total Assets</span>
                        <span className="font-mono">${bs.totalAssets}</span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3 border-b border-border pb-2">Liabilities</h3>
                    <div className="space-y-2">
                      {bs.liabilities.map((line) => (
                        <div key={line.accountId} className="flex justify-between text-sm py-1 px-2 rounded hover:bg-accent/50">
                          <span className="text-foreground">{line.name}</span>
                          <span className="font-mono">${line.amount}</span>
                        </div>
                      ))}
                      <div className="flex justify-between text-sm font-semibold pt-2 mt-2 border-t border-border px-2">
                        <span>Total Liabilities</span>
                        <span className="font-mono">${bs.totalLiabilities}</span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3 border-b border-border pb-2">Equity</h3>
                    <div className="space-y-2">
                      {bs.equity.map((line) => (
                        <div key={line.accountId} className="flex justify-between text-sm py-1 px-2 rounded hover:bg-accent/50">
                          <span className="text-foreground">{line.name}</span>
                          <span className="font-mono">${line.amount}</span>
                        </div>
                      ))}
                      <div className="flex justify-between text-sm py-1 px-2 text-muted-foreground">
                        <span>Current Net Income</span>
                        <span className="font-mono">${bs.netIncome}</span>
                      </div>
                      <div className="flex justify-between text-sm font-semibold pt-2 mt-2 border-t border-border px-2">
                        <span>Total Equity</span>
                        <span className="font-mono">${bs.equityWithIncome}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-between text-lg font-serif font-bold pt-4 border-t-2 border-border px-2">
                    <span>Total Liabilities & Equity</span>
                    <span className="font-mono text-primary">
                      ${bs.totalLiabilitiesAndEquity}
                    </span>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tb">
          <Card className="shadow-none border-border bg-card">
            <CardHeader className="border-b border-border bg-accent/30 pb-4">
              <CardTitle>Trial Balance</CardTitle>
              <CardDescription>All account balances</CardDescription>
            </CardHeader>
            <CardContent className="pt-0 p-0">
              {tbLoading ? (
                <div className="flex justify-center py-8"><Spinner /></div>
              ) : tb ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader className="bg-accent/20">
                      <TableRow className="border-border hover:bg-transparent">
                        <TableHead className="text-muted-foreground uppercase tracking-wider text-xs font-bold h-10">Code</TableHead>
                        <TableHead className="text-muted-foreground uppercase tracking-wider text-xs font-bold h-10">Account</TableHead>
                        <TableHead className="text-muted-foreground uppercase tracking-wider text-xs font-bold h-10">Type</TableHead>
                        <TableHead className="text-right text-muted-foreground uppercase tracking-wider text-xs font-bold h-10">Debit</TableHead>
                        <TableHead className="text-right text-muted-foreground uppercase tracking-wider text-xs font-bold h-10">Credit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tb.rows.map((row) => (
                        <TableRow key={row.accountId} className="border-border border-b hover:bg-accent/50">
                          <TableCell className="font-mono text-xs text-muted-foreground">{row.code}</TableCell>
                          <TableCell className="font-medium text-foreground">{row.name}</TableCell>
                          <TableCell className="capitalize text-muted-foreground text-xs">{row.type}</TableCell>
                          <TableCell className="text-right font-mono">${row.debit}</TableCell>
                          <TableCell className="text-right font-mono">${row.credit}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="font-bold bg-accent/30 border-t-2 border-border hover:bg-accent/30">
                        <TableCell colSpan={3} className="uppercase tracking-widest text-xs">Total</TableCell>
                        <TableCell className="text-right font-mono text-[#3CB54A]">${tb.totalDebit}</TableCell>
                        <TableCell className="text-right font-mono text-[#3CB54A]">${tb.totalCredit}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
