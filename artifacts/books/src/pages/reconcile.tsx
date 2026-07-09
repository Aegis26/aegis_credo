import { useState } from "react";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { 
  useListBankTransactions, 
  useListAccounts,
  useCategorizeBankTransaction,
  getListBankTransactionsQueryKey,
  getGetOrgDashboardQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { CheckCircle2, ChevronRight } from "lucide-react";

export default function Reconcile() {
  const { orgId } = useCurrentOrg();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: txnsData, isLoading: isLoadingTxns } = useListBankTransactions(
    orgId || "",
    { status: "unmatched" },
    {
      query: {
        enabled: !!orgId,
        queryKey: getListBankTransactionsQueryKey(orgId || "", { status: "unmatched" }),
      },
    }
  );

  const { data: accountsData, isLoading: isLoadingAccounts } = useListAccounts(orgId || "", {
    query: {
      enabled: !!orgId,
      queryKey: ["accounts", orgId],
    },
  });

  const categorize = useCategorizeBankTransaction();
  const [selectedAccounts, setSelectedAccounts] = useState<Record<string, string>>({});

  const handleCategorize = async (txnId: string, accountId: string) => {
    if (!orgId) return;
    if (!accountId) return;

    try {
      await categorize.mutateAsync({
        orgId,
        txnId,
        data: { accountId },
      });
      toast({ title: "Categorized", description: "Transaction recorded to ledger." });
      
      // Update local state temporarily for smooth UI, or rely on invalidation
      queryClient.invalidateQueries({ queryKey: getListBankTransactionsQueryKey(orgId, { status: "unmatched" }) });
      queryClient.invalidateQueries({ queryKey: getGetOrgDashboardQueryKey(orgId) });
      
      const newSelected = { ...selectedAccounts };
      delete newSelected[txnId];
      setSelectedAccounts(newSelected);
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to categorize transaction.",
      });
    }
  };

  if (!orgId) return null;

  if (isLoadingTxns || isLoadingAccounts) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="w-8 h-8 text-primary" />
      </div>
    );
  }

  const transactions = txnsData?.transactions || [];
  const accounts = accountsData?.accounts || [];

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Reconcile</h1>
        <p className="text-muted-foreground mt-1">Review bank transactions and categorize them to your ledger.</p>
      </div>

      <Card className="shadow-sm border-border">
        <CardHeader>
          <CardTitle>Uncategorized Transactions</CardTitle>
          <CardDescription>
            {transactions.length} transaction{transactions.length === 1 ? "" : "s"} waiting for review
          </CardDescription>
        </CardHeader>
        <CardContent>
          {transactions.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4 text-green-600">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <p className="text-lg font-medium text-foreground mb-1">All caught up!</p>
              <p className="text-sm text-muted-foreground">You have no uncategorized transactions.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {transactions.map((txn) => {
                const isNegative = txn.amount.startsWith("-");
                const absAmount = txn.amount.replace("-", "");

                // Money out is categorized against an expense; money in against
                // revenue. Cash / A/R / A/P etc. are never a "category" here.
                const categoryAccounts = accounts.filter((acc) =>
                  isNegative ? acc.type === "expense" : acc.type === "revenue",
                );

                // Pre-select the suggested account (by code) unless the user has
                // already picked one for this row.
                const suggestedId = txn.suggestedAccountCode
                  ? categoryAccounts.find(
                      (acc) => acc.code === txn.suggestedAccountCode,
                    )?.id ?? ""
                  : "";
                const effectiveAccountId =
                  selectedAccounts[txn.id] ?? suggestedId;

                return (
                  <div key={txn.id} className="flex flex-col sm:flex-row sm:items-center gap-4 p-4 rounded-lg border border-border bg-card/50 transition-colors hover:bg-card">
                    <div className="flex-1">
                      <p className="font-medium text-sm mb-1">{txn.description || "Bank Transaction"}</p>
                      <p className="text-xs text-muted-foreground">{format(new Date(txn.txnDate), "MMM d, yyyy")}</p>
                    </div>
                    
                    <div className={`font-medium w-24 text-right ${isNegative ? "text-foreground" : "text-green-600"}`}>
                      {isNegative ? "-" : "+"}${absAmount}
                    </div>

                    <div className="flex items-center gap-2 sm:w-80">
                      <Select 
                        value={effectiveAccountId} 
                        onValueChange={(val) => setSelectedAccounts({ ...selectedAccounts, [txn.id]: val })}
                      >
                        <SelectTrigger className="w-full bg-background h-9 text-sm">
                          <SelectValue placeholder="Select account..." />
                        </SelectTrigger>
                        <SelectContent>
                          {categoryAccounts.map((acc) => (
                            <SelectItem key={acc.id} value={acc.id}>
                              {acc.code} - {acc.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button 
                        size="sm"
                        disabled={!effectiveAccountId || categorize.isPending}
                        onClick={() => handleCategorize(txn.id, effectiveAccountId)}
                        className="h-9 w-9 p-0"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
