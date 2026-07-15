import { useState } from "react";
import { 
  useListPracticeClients, 
  useRunBatchReport,
  useBatchExportReports
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Download, Play, FileSpreadsheet, FileText } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function PracticeBatch() {
  const { data: clientsData, isLoading: clientsLoading } = useListPracticeClients();
  const clients = clientsData?.clients || [];
  
  const [selectedClients, setSelectedClients] = useState<string[]>([]);
  const [reportKind, setReportKind] = useState<"trialBalance" | "profitAndLoss" | "balanceSheet">("profitAndLoss");
  
  const runReport = useRunBatchReport();
  const exportReport = useBatchExportReports();
  const { toast } = useToast();

  const [activeTab, setActiveTab] = useState<"configure" | "results">("configure");

  const toggleClient = (id: string) => {
    setSelectedClients(prev => 
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
    );
  };

  const selectAll = () => {
    if (selectedClients.length === clients.length) {
      setSelectedClients([]);
    } else {
      setSelectedClients(clients.map(c => c.orgId));
    }
  };

  const handleRunReport = () => {
    if (selectedClients.length === 0) {
      toast({ title: "Select clients", description: "Please select at least one client to run the report.", variant: "destructive" });
      return;
    }

    runReport.mutate({
      data: {
        orgIds: selectedClients,
        kind: reportKind
      }
    }, {
      onSuccess: () => {
        setActiveTab("results");
        toast({ title: "Report generated successfully" });
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to run batch report", variant: "destructive" });
      }
    });
  };

  const handleExport = (format: "csv" | "excel") => {
    if (selectedClients.length === 0) {
      toast({ title: "Select clients", description: "Please select at least one client to export.", variant: "destructive" });
      return;
    }

    exportReport.mutate({
      data: {
        orgIds: selectedClients,
        kind: reportKind,
        format
      }
    }, {
      onSuccess: (data) => {
        toast({ title: "Export ready", description: `Downloaded ${data.files.length} file(s)` });
        
        data.files.forEach(file => {
          const blob = new Blob([file.content], { type: file.contentType });
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = file.name;
          document.body.appendChild(a);
          a.click();
          window.URL.revokeObjectURL(url);
          document.body.removeChild(a);
        });
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to export reports", variant: "destructive" });
      }
    });
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div>
        <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Batch Operations</h1>
        <p className="text-muted-foreground mt-1">Run reports across multiple client organizations simultaneously.</p>
      </div>

      <Tabs value={activeTab} onValueChange={(v: any) => setActiveTab(v)}>
        <TabsList>
          <TabsTrigger value="configure">Configure Report</TabsTrigger>
          <TabsTrigger value="results" disabled={!runReport.data}>Results</TabsTrigger>
        </TabsList>

        <TabsContent value="configure" className="space-y-6 mt-6">
          <div className="grid md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Select Report</CardTitle>
                <CardDescription>Choose the type of financial report to generate</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Report Type</Label>
                    <Select value={reportKind} onValueChange={(v: any) => setReportKind(v)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="profitAndLoss">Profit & Loss</SelectItem>
                        <SelectItem value="balanceSheet">Balance Sheet</SelectItem>
                        <SelectItem value="trialBalance">Trial Balance</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="flex-col items-stretch gap-3 border-t bg-muted/20 pt-6">
                <Button onClick={handleRunReport} disabled={runReport.isPending} className="w-full">
                  {runReport.isPending ? <Spinner className="mr-2" /> : <Play className="w-4 h-4 mr-2" />}
                  Run on Screen
                </Button>
                <div className="grid grid-cols-2 gap-3 w-full">
                  <Button variant="outline" onClick={() => handleExport("csv")} disabled={exportReport.isPending}>
                    <FileText className="w-4 h-4 mr-2" /> CSV
                  </Button>
                  <Button variant="outline" onClick={() => handleExport("excel")} disabled={exportReport.isPending}>
                    <FileSpreadsheet className="w-4 h-4 mr-2" /> Excel
                  </Button>
                </div>
              </CardFooter>
            </Card>

            <Card className="flex flex-col h-full">
              <CardHeader className="pb-3 border-b">
                <div className="flex items-center justify-between">
                  <CardTitle>Select Clients</CardTitle>
                  <Button variant="ghost" size="sm" onClick={selectAll}>
                    {selectedClients.length === clients.length ? "Deselect All" : "Select All"}
                  </Button>
                </div>
                <CardDescription>{selectedClients.length} of {clients.length} selected</CardDescription>
              </CardHeader>
              <CardContent className="pt-4 flex-1 overflow-y-auto max-h-[400px]">
                {clientsLoading ? (
                  <div className="flex justify-center py-8"><Spinner /></div>
                ) : clients.length === 0 ? (
                  <div className="text-center text-muted-foreground py-8">No clients available.</div>
                ) : (
                  <div className="space-y-3">
                    {clients.map((client) => (
                      <div key={client.orgId} className="flex items-center space-x-3 p-2 hover:bg-muted/50 rounded-md">
                        <Checkbox 
                          id={`client-${client.orgId}`} 
                          checked={selectedClients.includes(client.orgId)}
                          onCheckedChange={() => toggleClient(client.orgId)}
                        />
                        <Label htmlFor={`client-${client.orgId}`} className="flex-1 cursor-pointer font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                          {client.name}
                        </Label>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="results" className="mt-6">
          {runReport.data?.sheets.map((sheet, sIdx) => (
            <Card key={sIdx} className="mb-6 overflow-hidden">
              <CardHeader className="bg-muted/30 border-b pb-4">
                <CardTitle className="font-serif text-xl">{sheet.name}</CardTitle>
                <CardDescription>{runReport.data?.kind}</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {sheet.columns.map((col, cIdx) => (
                          <TableHead key={cIdx} className={cIdx > 0 ? "text-right" : ""}>{col}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sheet.rows.map((row, rIdx) => (
                        <TableRow key={rIdx}>
                          {row.map((cell, cellIdx) => (
                            <TableCell key={cellIdx} className={cellIdx > 0 ? "text-right font-mono text-sm" : "font-medium"}>
                              {cell}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}
