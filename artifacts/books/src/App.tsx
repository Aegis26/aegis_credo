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
import ResetPassword from "@/pages/reset-password";
import Onboarding from "@/pages/onboarding";
import Dashboard from "@/pages/dashboard";
import Bank from "@/pages/bank";
import Reconcile from "@/pages/reconcile";
import Invoices from "@/pages/invoices";
import Reports from "@/pages/reports";
import Taxes from "@/pages/taxes";
import TaxForms from "@/pages/tax-forms";
import ImportPage from "@/pages/import";
import Bills from "@/pages/bills";
import Aging from "@/pages/aging";
import Payroll from "@/pages/payroll";
import Team from "@/pages/team";
import Entities from "@/pages/entities";
import Approvals from "@/pages/approvals";
import ReportBuilder from "@/pages/report-builder";
import Budgets from "@/pages/budgets";
import SettingsIntegrations from "@/pages/settings/integrations";

import PracticeDashboard from "@/pages/practice/dashboard";
import PracticeClientClose from "@/pages/practice/close";
import PracticeBatch from "@/pages/practice/batch";
import PracticeSetup from "@/pages/practice/setup";

const queryClient = new QueryClient();

function OrgGuard({ children }: { children: React.ReactNode }) {
  const { data: orgsData, isLoading, isFetching } = useListMyOrgs();
  const [location, setLocation] = useLocation();

  const settledEmpty = !isFetching && orgsData !== undefined && orgsData.orgs.length === 0;

  useEffect(() => {
    if (settledEmpty && location !== "/onboarding" && !location.startsWith("/practice/setup")) {
      setLocation("/onboarding");
    }
  }, [settledEmpty, location, setLocation]);

  if (isLoading || (isFetching && (!orgsData || orgsData.orgs.length === 0))) {
    return null;
  }

  if (settledEmpty && location !== "/onboarding" && !location.startsWith("/practice/setup")) {
    return null;
  }

  if (location === "/onboarding" || location.startsWith("/practice/setup")) {
    return <AppShell>{children}</AppShell>;
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
            <Route path="/import" component={ImportPage} />
            <Route path="/bank" component={Bank} />
            <Route path="/reconcile" component={Reconcile} />
            <Route path="/invoices" component={Invoices} />
            <Route path="/bills" component={Bills} />
            <Route path="/aging" component={Aging} />
            <Route path="/payroll" component={Payroll} />
            <Route path="/reports" component={Reports} />
            <Route path="/report-builder" component={ReportBuilder} />
            <Route path="/entities" component={Entities} />
            <Route path="/approvals" component={Approvals} />
            <Route path="/budgets" component={Budgets} />
            <Route path="/settings/integrations" component={SettingsIntegrations} />
            <Route path="/taxes" component={Taxes} />
            <Route path="/tax-forms" component={TaxForms} />
            <Route path="/team" component={Team} />
            
            <Route path="/practice" component={PracticeDashboard} />
            <Route path="/practice/batch" component={PracticeBatch} />
            <Route path="/practice/setup" component={PracticeSetup} />
            <Route path="/practice/close/:orgId" component={PracticeClientClose} />
            
            <Route component={NotFound} />
          </Switch>
        </OrgGuard>
      </CurrentOrgProvider>
    </AuthGuard>
  );
}

function RedirectToLogin() {
  const [, setLocation] = useLocation();
  useEffect(() => {
    setLocation("/login", { replace: true });
  }, [setLocation]);
  return null;
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/reset-password" component={ResetPassword} />
      {/* Public signup is disabled (invite-only); redirect to login. */}
      <Route path="/signup" component={RedirectToLogin} />
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
