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
        <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Reports</h1>
        <p className="text-muted-foreground mt-1">Financial statements for your business.</p>
      </div>

      <Tabs defaultValue="pnl" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="pnl">Profit & Loss</TabsTrigger>
          <TabsTrigger value="bs">Balance Sheet</TabsTrigger>
          <TabsTrigger value="tb">Trial Balance</TabsTrigger>
        </TabsList>

        <TabsContent value="pnl">
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle>Profit & Loss</CardTitle>
              <CardDescription>Income and expenses for the current period</CardDescription>
            </CardHeader>
            <CardContent>
              {pnlLoading ? (
                <div className="flex justify-center py-8"><Spinner /></div>
              ) : pnl ? (
                <div className="space-y-8">
                  <div>
                    <h3 className="text-sm font-medium uppercase text-muted-foreground mb-3 border-b pb-2">Revenue</h3>
                    <div className="space-y-2">
                      {pnl.revenue.map((line) => (
                        <div key={line.accountId} className="flex justify-between text-sm py-1">
                          <span>{line.name}</span>
                          <span>${line.amount}</span>
                        </div>
                      ))}
                      <div className="flex justify-between text-sm font-semibold pt-2 mt-2 border-t">
                        <span>Total Revenue</span>
                        <span>${pnl.totalRevenue}</span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-sm font-medium uppercase text-muted-foreground mb-3 border-b pb-2">Expenses</h3>
                    <div className="space-y-2">
                      {pnl.expenses.map((line) => (
                        <div key={line.accountId} className="flex justify-between text-sm py-1">
                          <span>{line.name}</span>
                          <span>${line.amount}</span>
                        </div>
                      ))}
                      <div className="flex justify-between text-sm font-semibold pt-2 mt-2 border-t">
                        <span>Total Expenses</span>
                        <span>${pnl.totalExpenses}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-between text-lg font-serif font-bold pt-4 border-t-2 border-primary">
                    <span>Net Income</span>
                    <span className={pnl.netIncome.startsWith("-") ? "text-destructive" : "text-green-700"}>
                      ${pnl.netIncome}
                    </span>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="bs">
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle>Balance Sheet</CardTitle>
              <CardDescription>Assets, liabilities, and equity</CardDescription>
            </CardHeader>
            <CardContent>
              {bsLoading ? (
                <div className="flex justify-center py-8"><Spinner /></div>
              ) : bs ? (
                <div className="space-y-8">
                  <div>
                    <h3 className="text-sm font-medium uppercase text-muted-foreground mb-3 border-b pb-2">Assets</h3>
                    <div className="space-y-2">
                      {bs.assets.map((line) => (
                        <div key={line.accountId} className="flex justify-between text-sm py-1">
                          <span>{line.name}</span>
                          <span>${line.amount}</span>
                        </div>
                      ))}
                      <div className="flex justify-between text-sm font-semibold pt-2 mt-2 border-t">
                        <span>Total Assets</span>
                        <span>${bs.totalAssets}</span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-sm font-medium uppercase text-muted-foreground mb-3 border-b pb-2">Liabilities</h3>
                    <div className="space-y-2">
                      {bs.liabilities.map((line) => (
                        <div key={line.accountId} className="flex justify-between text-sm py-1">
                          <span>{line.name}</span>
                          <span>${line.amount}</span>
                        </div>
                      ))}
                      <div className="flex justify-between text-sm font-semibold pt-2 mt-2 border-t">
                        <span>Total Liabilities</span>
                        <span>${bs.totalLiabilities}</span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-sm font-medium uppercase text-muted-foreground mb-3 border-b pb-2">Equity</h3>
                    <div className="space-y-2">
                      {bs.equity.map((line) => (
                        <div key={line.accountId} className="flex justify-between text-sm py-1">
                          <span>{line.name}</span>
                          <span>${line.amount}</span>
                        </div>
                      ))}
                      <div className="flex justify-between text-sm py-1 text-muted-foreground">
                        <span>Current Net Income</span>
                        <span>${bs.netIncome}</span>
                      </div>
                      <div className="flex justify-between text-sm font-semibold pt-2 mt-2 border-t">
                        <span>Total Equity</span>
                        <span>${bs.equityWithIncome}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-between text-lg font-serif font-bold pt-4 border-t-2 border-primary">
                    <span>Total Liabilities & Equity</span>
                    <span>
                      ${bs.totalLiabilitiesAndEquity}
                    </span>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tb">
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle>Trial Balance</CardTitle>
              <CardDescription>All account balances</CardDescription>
            </CardHeader>
            <CardContent>
              {tbLoading ? (
                <div className="flex justify-center py-8"><Spinner /></div>
              ) : tb ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Code</TableHead>
                        <TableHead>Account</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead className="text-right">Debit</TableHead>
                        <TableHead className="text-right">Credit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tb.rows.map((row) => (
                        <TableRow key={row.accountId}>
                          <TableCell className="font-mono text-xs">{row.code}</TableCell>
                          <TableCell>{row.name}</TableCell>
                          <TableCell className="capitalize text-muted-foreground text-xs">{row.type}</TableCell>
                          <TableCell className="text-right">${row.debit}</TableCell>
                          <TableCell className="text-right">${row.credit}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="font-bold bg-muted/20">
                        <TableCell colSpan={3}>Total</TableCell>
                        <TableCell className="text-right">${tb.totalDebit}</TableCell>
                        <TableCell className="text-right">${tb.totalCredit}</TableCell>
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
