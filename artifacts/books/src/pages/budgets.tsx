import { useState } from "react";
import {
  useListOrgBudgets,
  useCreateOrgBudget,
  useSetOrgBudgetLine,
  useGetBudgetVsActualReport,
  useListAccounts,
  getListOrgBudgetsQueryKey,
  getGetBudgetVsActualReportQueryKey,
  getListAccountsQueryKey,
} from "@workspace/api-client-react";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Wallet, PencilLine } from "lucide-react";

export default function Budgets() {
  const { orgId } = useCurrentOrg();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [selectedBudgetId, setSelectedBudgetId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");

  const [lineOpen, setLineOpen] = useState(false);
  const [lineAccountId, setLineAccountId] = useState("");
  const [lineAmount, setLineAmount] = useState("");

  const { data: budgetsData, isLoading } = useListOrgBudgets(orgId || "", {
    query: { enabled: !!orgId, queryKey: getListOrgBudgetsQueryKey(orgId || "") },
  });

  const { data: accountsData } = useListAccounts(orgId || "", {
    query: { enabled: !!orgId, queryKey: getListAccountsQueryKey(orgId || "") },
  });

  const createBudget = useCreateOrgBudget();
  const setLine = useSetOrgBudgetLine();

  const budgets = budgetsData?.budgets ?? [];
  const activeBudgetId = selectedBudgetId ?? budgets[0]?.id ?? null;
  const accounts = accountsData?.accounts ?? [];

  const { data: vsActual, isLoading: vsLoading } = useGetBudgetVsActualReport(
    orgId || "",
    activeBudgetId || "",
    {
      query: {
        enabled: !!orgId && !!activeBudgetId,
        queryKey: getGetBudgetVsActualReportQueryKey(orgId || "", activeBudgetId || ""),
      },
    },
  );

  const handleCreate = async () => {
    if (!orgId || !name.trim() || !periodStart || !periodEnd) return;
    try {
      const budget = await createBudget.mutateAsync({
        orgId,
        data: { name: name.trim(), periodStart, periodEnd },
      });
      toast({ title: "Budget created", description: `${budget.name} is ready.` });
      setName("");
      setPeriodStart("");
      setPeriodEnd("");
      setCreateOpen(false);
      setSelectedBudgetId(budget.id);
      queryClient.invalidateQueries({ queryKey: getListOrgBudgetsQueryKey(orgId) });
    } catch {
      toast({ variant: "destructive", title: "Error", description: "Could not create the budget." });
    }
  };

  const handleSetLine = async () => {
    if (!orgId || !activeBudgetId || !lineAccountId || !lineAmount.trim()) return;
    try {
      await setLine.mutateAsync({
        orgId,
        budgetId: activeBudgetId,
        data: { accountId: lineAccountId, amount: lineAmount.trim() },
      });
      toast({ title: "Line saved", description: "Budget line updated." });
      setLineAccountId("");
      setLineAmount("");
      setLineOpen(false);
      queryClient.invalidateQueries({
        queryKey: getGetBudgetVsActualReportQueryKey(orgId, activeBudgetId),
      });
    } catch {
      toast({ variant: "destructive", title: "Error", description: "Could not save the budget line." });
    }
  };

  if (!orgId) return null;
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="w-8 h-8 text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Budgets</h1>
          <p className="text-muted-foreground mt-1">Track budget versus actual across your accounts.</p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="w-4 h-4" />
              New budget
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Create a budget</DialogTitle>
              <DialogDescription>Define a name and period.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input placeholder="FY2026 Operating" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Period start</Label>
                  <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Period end</Label>
                  <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={handleCreate}
                disabled={createBudget.isPending || !name.trim() || !periodStart || !periodEnd}
              >
                {createBudget.isPending ? "Creating..." : "Create budget"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {budgets.length === 0 ? (
        <Card className="shadow-sm">
          <CardContent className="text-center py-16 text-muted-foreground">
            <Wallet className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p>No budgets yet. Create one to start tracking.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {budgets.map((b) => (
              <Button
                key={b.id}
                variant={b.id === activeBudgetId ? "default" : "outline"}
                size="sm"
                onClick={() => setSelectedBudgetId(b.id)}
                className="gap-2"
              >
                <Wallet className="w-4 h-4" />
                {b.name}
              </Button>
            ))}
          </div>

          <Card className="shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Budget vs Actual</CardTitle>
                <CardDescription>Budgeted amounts compared to posted activity.</CardDescription>
              </div>
              <Dialog open={lineOpen} onOpenChange={setLineOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2">
                    <PencilLine className="w-4 h-4" />
                    Set line
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[425px]">
                  <DialogHeader>
                    <DialogTitle>Set a budget line</DialogTitle>
                    <DialogDescription>Assign a budgeted amount to an account.</DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>Account</Label>
                      <Select value={lineAccountId} onValueChange={setLineAccountId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select an account" />
                        </SelectTrigger>
                        <SelectContent>
                          {accounts.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.code} — {a.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Amount</Label>
                      <Input placeholder="1000.00" value={lineAmount} onChange={(e) => setLineAmount(e.target.value)} />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button
                      onClick={handleSetLine}
                      disabled={setLine.isPending || !lineAccountId || !lineAmount.trim()}
                    >
                      {setLine.isPending ? "Saving..." : "Save line"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </CardHeader>
            <CardContent>
              {vsLoading ? (
                <div className="flex justify-center py-8">
                  <Spinner />
                </div>
              ) : vsActual ? (
                vsActual.rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No budget lines yet. Use "Set line" to add one.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Code</TableHead>
                          <TableHead>Account</TableHead>
                          <TableHead className="text-right">Budgeted</TableHead>
                          <TableHead className="text-right">Actual</TableHead>
                          <TableHead className="text-right">Variance</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {vsActual.rows.map((row) => (
                          <TableRow key={row.accountId}>
                            <TableCell className="font-mono text-xs">{row.code}</TableCell>
                            <TableCell>{row.name}</TableCell>
                            <TableCell className="text-right">${row.budgeted}</TableCell>
                            <TableCell className="text-right">${row.actual}</TableCell>
                            <TableCell
                              className={`text-right ${row.variance.startsWith("-") ? "text-destructive" : "text-green-700"}`}
                            >
                              ${row.variance}
                            </TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="font-bold bg-muted/20">
                          <TableCell colSpan={2}>Total</TableCell>
                          <TableCell className="text-right">${vsActual.totalBudgeted}</TableCell>
                          <TableCell className="text-right">${vsActual.totalActual}</TableCell>
                          <TableCell
                            className={`text-right ${vsActual.totalVariance.startsWith("-") ? "text-destructive" : "text-green-700"}`}
                          >
                            ${vsActual.totalVariance}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                )
              ) : (
                <p className="text-sm text-muted-foreground">Select a budget to view its report.</p>
              )}
            </CardContent>
          </Card>

          {vsActual?.budget && (
            <div className="text-sm text-muted-foreground">
              <Badge variant="outline">
                {vsActual.budget.periodStart} → {vsActual.budget.periodEnd}
              </Badge>
            </div>
          )}
        </>
      )}
    </div>
  );
}
