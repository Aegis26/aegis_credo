import { 
  useListPracticeClients, 
  useGetPracticeDashboard,
  getGetPracticeDashboardQueryKey 
} from "@workspace/api-client-react";
import { Link, useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, Building2, Briefcase, FileText, CheckCircle2, Clock, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function PracticeDashboard() {
  const { data: clientsData, isLoading: clientsLoading } = useListPracticeClients();
  const { data: dashboard, isLoading: dashboardLoading } = useGetPracticeDashboard();
  const [, setLocation] = useLocation();

  if (clientsLoading || dashboardLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="w-8 h-8 text-primary" />
      </div>
    );
  }

  const clients = clientsData?.clients || [];
  const clientData = dashboard?.clients || [];

  if (clients.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-96 text-center space-y-6">
        <div className="bg-primary/10 p-6 rounded-full">
          <Briefcase className="w-12 h-12 text-primary" />
        </div>
        <div className="max-w-md">
          <h2 className="text-2xl font-serif font-semibold text-foreground mb-2">Welcome to your Practice</h2>
          <p className="text-muted-foreground mb-6">
            You don't have any clients yet. Set up your practice and grant access to client organizations to manage them from here.
          </p>
          <Button onClick={() => setLocation("/practice/setup")}>
            Setup Practice
          </Button>
        </div>
      </div>
    );
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "closed": return "bg-green-100 text-green-800 border-green-200";
      case "in_review": return "bg-blue-100 text-blue-800 border-blue-200";
      case "in_progress": return "bg-amber-100 text-amber-800 border-amber-200";
      default: return "bg-gray-100 text-gray-800 border-gray-200";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "closed": return <CheckCircle2 className="w-4 h-4 mr-1" />;
      case "in_review": return <AlertCircle className="w-4 h-4 mr-1" />;
      case "in_progress": return <Clock className="w-4 h-4 mr-1" />;
      default: return <Clock className="w-4 h-4 mr-1" />;
    }
  };

  const formatStatus = (status: string) => {
    return status.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Practice Dashboard</h1>
          <p className="text-muted-foreground mt-1">Overview of all your client organizations.</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => setLocation("/practice/batch")}>
            <FileText className="w-4 h-4 mr-2" />
            Batch Reports
          </Button>
          <Button onClick={() => setLocation("/practice/setup")}>
            <Building2 className="w-4 h-4 mr-2" />
            Manage Clients
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
        {clientData.map((client) => (
          <Card 
            key={client.orgId} 
            className="flex flex-col hover:border-primary/50 transition-colors cursor-pointer"
            onClick={() => setLocation(`/practice/close/${client.orgId}`)}
          >
            <CardHeader className="pb-4 border-b">
              <div className="flex justify-between items-start">
                <div>
                  <CardTitle className="text-xl font-serif">{client.name}</CardTitle>
                  <CardDescription className="mt-1">ID: {client.orgId.substring(0, 8)}...</CardDescription>
                </div>
                <div className="p-2 bg-muted rounded-md">
                  <Building2 className="w-5 h-5 text-muted-foreground" />
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-4 flex-1 flex flex-col justify-between">
              {client.close && client.close.period ? (
                <div className="space-y-4 mb-6">
                  <div>
                    <div className="text-sm font-medium text-muted-foreground mb-1.5">Latest Period</div>
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{client.close.period}</span>
                      <Badge variant="outline" className={getStatusColor(client.close.status ?? "open")}>
                        {getStatusIcon(client.close.status ?? "open")}
                        {formatStatus(client.close.status ?? "open")}
                      </Badge>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-muted/50 p-3 rounded-md">
                      <div className="text-xs text-muted-foreground mb-1">Tasks</div>
                      <div className="font-medium">
                        {client.close.tasksDone} / {client.close.tasksTotal}
                      </div>
                    </div>
                    <div className="bg-muted/50 p-3 rounded-md">
                      <div className="text-xs text-muted-foreground mb-1">Open PBCs</div>
                      <div className="font-medium">
                        {client.close.openPbc}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="py-6 text-center text-sm text-muted-foreground bg-muted/30 rounded-md mb-6 border border-dashed">
                  No close periods configured
                </div>
              )}

              {client.financials && (
                <div className="grid grid-cols-2 gap-4 pt-4 border-t mt-auto">
                  <div>
                    <div className="text-xs text-muted-foreground">Net Income</div>
                    <div className={`font-semibold ${client.financials.netIncome.startsWith('-') ? 'text-destructive' : 'text-green-700'}`}>
                      ${client.financials.netIncome}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Assets</div>
                    <div className="font-semibold">${client.financials.assets}</div>
                  </div>
                </div>
              )}
            </CardContent>
            <div className="bg-muted/50 px-6 py-3 flex items-center justify-end text-sm text-primary font-medium hover:bg-muted/80 transition-colors rounded-b-lg border-t">
              Manage Close <ChevronRight className="w-4 h-4 ml-1" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
