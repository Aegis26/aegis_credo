import { useState } from "react";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { 
  useGetBankStatus, 
  useCreateBankLinkToken, 
  useExchangeBankToken, 
  useSyncBank,
  getGetBankStatusQueryKey,
  getListBankTransactionsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { usePlaidLink } from "react-plaid-link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/hooks/use-toast";
import { Landmark, RefreshCw, AlertCircle, CheckCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function Bank() {
  const { orgId } = useCurrentOrg();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [linkToken, setLinkToken] = useState<string | null>(null);

  const { data: status, isLoading } = useGetBankStatus(orgId || "", {
    query: {
      enabled: !!orgId,
      queryKey: getGetBankStatusQueryKey(orgId || ""),
    },
  });

  const createToken = useCreateBankLinkToken();
  const exchangeToken = useExchangeBankToken();
  const syncBank = useSyncBank();

  const handleConnectClick = async () => {
    if (!orgId) return;
    try {
      const { linkToken } = await createToken.mutateAsync({ orgId });
      setLinkToken(linkToken);
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to initialize bank connection.",
      });
    }
  };

  const { open, ready } = usePlaidLink({
    token: linkToken!,
    onSuccess: async (public_token) => {
      if (!orgId) return;
      try {
        await exchangeToken.mutateAsync({
          orgId,
          data: { publicToken: public_token },
        });
        toast({ title: "Bank connected", description: "Successfully linked your account." });
        await handleSync();
      } catch (e) {
        toast({
          variant: "destructive",
          title: "Connection failed",
          description: "Failed to link your bank account.",
        });
      }
    },
    onExit: () => {
      setLinkToken(null);
    }
  });

  const handleSync = async () => {
    if (!orgId) return;
    try {
      await syncBank.mutateAsync({ orgId });
      toast({ title: "Sync complete", description: "Your transactions are up to date." });
      queryClient.invalidateQueries({ queryKey: getGetBankStatusQueryKey(orgId) });
      queryClient.invalidateQueries({ queryKey: getListBankTransactionsQueryKey(orgId) });
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Sync failed",
        description: "Could not sync transactions right now.",
      });
    }
  };

  // When linkToken is set and ready, open Plaid link automatically
  if (linkToken && ready) {
    open();
    setLinkToken(null); // clear after opening
  }

  if (!orgId) return null;

  if (isLoading || !status) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="w-8 h-8 text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <div>
        <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Bank Connection</h1>
        <p className="text-muted-foreground mt-1">Connect your accounts to automatically import transactions.</p>
      </div>

      {!status.configured ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Bank connection isn't set up yet</AlertTitle>
          <AlertDescription>
            The system needs Plaid credentials to connect banks. Once configured, you'll be able to link your accounts here.
          </AlertDescription>
        </Alert>
      ) : (
        <Card className="shadow-sm border-border">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Landmark className="w-5 h-5 text-primary" />
              <CardTitle>Linked Accounts</CardTitle>
            </div>
            <CardDescription>Manage your bank feeds</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {status.connected ? (
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50 border border-border">
                  <div className="flex items-center gap-3">
                    <CheckCircle className="w-8 h-8 text-green-600" />
                    <div>
                      <p className="font-medium text-foreground">{status.institutionName || "Connected Bank"}</p>
                      <p className="text-sm text-muted-foreground">
                        {status.lastSyncedAt ? `Last synced: ${new Date(status.lastSyncedAt).toLocaleString()}` : "Never synced"}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium">{status.pendingCount} pending</p>
                    <p className="text-xs text-muted-foreground">transactions</p>
                  </div>
                </div>

                {status.lastSyncError && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Sync Error</AlertTitle>
                    <AlertDescription>{status.lastSyncError}</AlertDescription>
                  </Alert>
                )}
              </div>
            ) : (
              <div className="text-center py-8">
                <Landmark className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-20" />
                <p className="text-foreground font-medium mb-1">No bank connected</p>
                <p className="text-sm text-muted-foreground mb-4">Connect your bank to start importing transactions automatically.</p>
                <Button 
                  onClick={handleConnectClick} 
                  disabled={createToken.isPending || !!linkToken}
                >
                  {createToken.isPending ? "Connecting..." : "Connect Bank"}
                </Button>
              </div>
            )}
          </CardContent>
          {status.connected && (
            <CardFooter className="bg-muted/30 border-t border-border py-3 px-6 flex justify-between">
              <span className="text-xs text-muted-foreground">
                Transactions sync automatically, but you can sync manually if needed.
              </span>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handleSync} 
                disabled={syncBank.isPending}
                className="gap-2"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncBank.isPending ? "animate-spin" : ""}`} />
                {syncBank.isPending ? "Syncing..." : "Sync Now"}
              </Button>
            </CardFooter>
          )}
        </Card>
      )}
    </div>
  );
}
