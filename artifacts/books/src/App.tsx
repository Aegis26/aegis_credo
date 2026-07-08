import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEffect } from "react";
import { useListMyOrgs } from "@workspace/api-client-react";
import NotFound from "@/pages/not-found";

import { AuthGuard } from "@/components/auth-guard";
import { AppShell } from "@/components/app-shell";
import { CurrentOrgProvider } from "@/hooks/use-current-org";

import Login from "@/pages/login";
import Signup from "@/pages/signup";
import Onboarding from "@/pages/onboarding";
import Dashboard from "@/pages/dashboard";
import Bank from "@/pages/bank";
import Reconcile from "@/pages/reconcile";
import Invoices from "@/pages/invoices";
import Reports from "@/pages/reports";
import Taxes from "@/pages/taxes";

const queryClient = new QueryClient();

function OrgGuard({ children }: { children: React.ReactNode }) {
  const { data: orgsData, isLoading, isFetching } = useListMyOrgs();
  const [location, setLocation] = useLocation();

  const settledEmpty = !isFetching && orgsData !== undefined && orgsData.orgs.length === 0;

  useEffect(() => {
    if (settledEmpty && location !== "/onboarding") {
      setLocation("/onboarding");
    }
  }, [settledEmpty, location, setLocation]);

  // Wait while the org list is loading or refetching (e.g. right after
  // onboarding creates the first org) so we never act on stale-empty data.
  if (isLoading || (isFetching && (!orgsData || orgsData.orgs.length === 0))) {
    return null;
  }

  if (settledEmpty && location !== "/onboarding") {
    return null;
  }

  if (location === "/onboarding") {
    return <>{children}</>;
  }

  return <AppShell>{children}</AppShell>;
}

function ProtectedRouter() {
  return (
    <AuthGuard>
      <CurrentOrgProvider>
        <OrgGuard>
          <Switch>
            <Route path="/onboarding" component={Onboarding} />
            <Route path="/" component={Dashboard} />
            <Route path="/bank" component={Bank} />
            <Route path="/reconcile" component={Reconcile} />
            <Route path="/invoices" component={Invoices} />
            <Route path="/reports" component={Reports} />
            <Route path="/taxes" component={Taxes} />
            <Route component={NotFound} />
          </Switch>
        </OrgGuard>
      </CurrentOrgProvider>
    </AuthGuard>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/signup" component={Signup} />
      <Route component={ProtectedRouter} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
