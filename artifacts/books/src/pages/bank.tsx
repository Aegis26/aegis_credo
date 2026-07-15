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
import { Landmark, RefreshCw, AlertCircle, CheckCircle, ShieldCheck } from "lucide-react";
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
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-serif font-semibold tracking-tight text-foreground">Bank Connection</h1>
        <p className="text-muted-foreground mt-1">Connect your accounts to automatically sync transactions securely.</p>
      </div>

      {!status.configured ? (
        <Alert className="bg-accent/20 border-border">
          <AlertCircle className="h-4 w-4 text-primary" />
          <AlertTitle className="text-foreground">Bank connection isn't set up yet</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            The system needs Plaid credentials to connect banks. Once configured, you'll be able to securely link your accounts here.
          </AlertDescription>
        </Alert>
      ) : (
        <Card className="shadow-none border-border bg-card">
          <CardHeader className="border-b border-border bg-accent/30 pb-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-primary" />
              <CardTitle>Secure Bank Feeds</CardTitle>
            </div>
            <CardDescription>Manage your institutional connections</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            {status.connected ? (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between p-6 rounded-md bg-background border border-border">
                  <div className="flex items-center gap-4 mb-4 sm:mb-0">
                    <div className="bg-[#3CB54A]/10 p-3 rounded-full">
                      <CheckCircle className="w-6 h-6 text-[#3CB54A]" />
                    </div>
                    <div>
                      <p className="font-semibold text-foreground text-lg">{status.institutionName || "Connected Bank"}</p>
                      <p className="text-xs font-mono text-muted-foreground mt-1">
                        {status.lastSyncedAt ? `Last synced: ${new Date(status.lastSyncedAt).toLocaleString()}` : "Never synced"}
                      </p>
                    </div>
                  </div>
                  <div className="text-left sm:text-right bg-accent/30 p-3 rounded-md border border-border/50">
                    <p className="text-sm font-semibold text-primary">{status.pendingCount} pending</p>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider">transactions</p>
                  </div>
                </div>

                {status.lastSyncError && (
                  <Alert variant="destructive" className="bg-destructive/10 border-destructive/30">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Sync Error</AlertTitle>
                    <AlertDescription>{status.lastSyncError}</AlertDescription>
                  </Alert>
                )}
              </div>
            ) : (
              <div className="text-center py-16 px-4 bg-accent/20 rounded-md border border-border border-dashed m-2">
                <Landmark className="w-16 h-16 text-muted-foreground mx-auto mb-4 opacity-40" />
                <p className="text-xl font-medium text-foreground mb-2">No active connection</p>
                <p className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">Connect your bank securely via Plaid to start syncing transactions automatically into your ledger.</p>
                <Button 
                  onClick={handleConnectClick} 
                  disabled={createToken.isPending || !!linkToken}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {createToken.isPending ? "Initializing Secure Link..." : "Establish Connection"}
                </Button>
              </div>
            )}
          </CardContent>
          {status.connected && (
            <CardFooter className="bg-accent/30 border-t border-border py-4 px-6 flex flex-col sm:flex-row gap-4 items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Transactions sync automatically, but you can force a refresh.
              </span>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handleSync} 
                disabled={syncBank.isPending}
                className="gap-2 border-primary/50 hover:bg-primary hover:text-primary-foreground"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncBank.isPending ? "animate-spin" : ""}`} />
                {syncBank.isPending ? "Syncing ledger..." : "Force Sync"}
              </Button>
            </CardFooter>
          )}
        </Card>
      )}
    </div>
  );
}
