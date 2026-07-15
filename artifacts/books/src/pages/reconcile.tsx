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
import { CheckCircle2, ChevronRight, ShieldCheck } from "lucide-react";

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
    <div className="space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-3xl font-serif font-semibold tracking-tight text-foreground">Reconcile</h1>
        <p className="text-muted-foreground mt-1">Review bank transactions and match to your ledger.</p>
      </div>

      <Card className="shadow-none border-border bg-card">
        <CardHeader className="border-b border-border bg-accent/30 pb-4">
          <CardTitle>Unmatched Transactions</CardTitle>
          <CardDescription>
            {transactions.length} transaction{transactions.length === 1 ? "" : "s"} waiting for review
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6 p-0 sm:p-6">
          {transactions.length === 0 ? (
            <div className="text-center py-16 px-4 bg-accent/20 rounded-md border border-border border-dashed m-6">
              <div className="w-16 h-16 bg-[#3CB54A]/10 rounded-full flex items-center justify-center mx-auto mb-4 text-[#3CB54A]">
                <ShieldCheck className="w-8 h-8" />
              </div>
              <p className="text-xl font-medium text-foreground mb-2">Ledger Secured</p>
              <p className="text-sm text-muted-foreground">All transactions have been verified and categorized.</p>
            </div>
          ) : (
            <div className="divide-y divide-border border-y sm:border sm:rounded-md border-border overflow-hidden">
              {transactions.map((txn) => {
                const isNegative = txn.amount.startsWith("-");
                const absAmount = txn.amount.replace("-", "");

                const categoryAccounts = accounts.filter((acc) =>
                  isNegative ? acc.type === "expense" : acc.type === "revenue",
                );

                const suggestedId = txn.suggestedAccountCode
                  ? categoryAccounts.find(
                      (acc) => acc.code === txn.suggestedAccountCode,
                    )?.id ?? ""
                  : "";
                const effectiveAccountId =
                  selectedAccounts[txn.id] ?? suggestedId;

                return (
                  <div key={txn.id} className="flex flex-col sm:flex-row sm:items-center p-4 bg-background transition-colors hover:bg-accent/30">
                    <div className="flex-1 min-w-0 mb-4 sm:mb-0 pr-4">
                      <p className="font-medium text-sm text-foreground truncate">{txn.description || "Bank Transaction"}</p>
                      <p className="text-xs text-muted-foreground mt-1">{format(new Date(txn.txnDate), "MMM d, yyyy")}</p>
                    </div>
                    
                    <div className={`font-mono text-sm w-32 mb-4 sm:mb-0 ${isNegative ? "text-foreground" : "text-[#3CB54A]"}`}>
                      {isNegative ? "-" : "+"}${absAmount}
                    </div>

                    <div className="flex items-center gap-2 sm:w-80 flex-shrink-0">
                      <Select 
                        value={effectiveAccountId} 
                        onValueChange={(val) => setSelectedAccounts({ ...selectedAccounts, [txn.id]: val })}
                      >
                        <SelectTrigger className="w-full bg-input/50 h-9 text-sm focus:border-primary border-border">
                          <SelectValue placeholder="Select classification..." />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border">
                          {categoryAccounts.map((acc) => (
                            <SelectItem key={acc.id} value={acc.id}>
                              <span className="font-mono text-xs text-muted-foreground mr-2">{acc.code}</span>
                              {acc.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button 
                        size="sm"
                        disabled={!effectiveAccountId || categorize.isPending}
                        onClick={() => handleCategorize(txn.id, effectiveAccountId)}
                        className="h-9 w-12 p-0 flex-shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
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
