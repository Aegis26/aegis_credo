import { useState } from "react";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { 
  useListInvoices, 
  useCreateInvoice, 
  useSendInvoice, 
  usePayInvoice,
  useListAccounts,
  getListInvoicesQueryKey,
  getGetOrgDashboardQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { FileText, Send, DollarSign, Plus } from "lucide-react";

const invoiceSchema = z.object({
  customer: z.string().min(1, "Customer name is required"),
  invoiceNumber: z.string().optional(),
  invoiceDate: z.string().min(1, "Invoice date is required"),
  dueDate: z.string().min(1, "Due date is required"),
  amount: z.string().min(1, "Amount is required"),
  revenueAccountId: z.string().optional(),
});

type InvoiceForm = z.infer<typeof invoiceSchema>;

export default function Invoices() {
  const { orgId } = useCurrentOrg();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const { data: invoicesData, isLoading } = useListInvoices(orgId || "", {
    query: {
      enabled: !!orgId,
      queryKey: getListInvoicesQueryKey(orgId || ""),
    },
  });

  const { data: accountsData } = useListAccounts(orgId || "", {
    query: {
      enabled: !!orgId,
      queryKey: ["accounts", orgId],
    },
  });

  const createInvoice = useCreateInvoice();
  const sendInvoice = useSendInvoice();
  const payInvoice = usePayInvoice();

  const form = useForm<InvoiceForm>({
    resolver: zodResolver(invoiceSchema),
    defaultValues: {
      customer: "",
      invoiceNumber: "",
      invoiceDate: new Date().toISOString().split('T')[0],
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      amount: "",
      revenueAccountId: "",
    },
  });

  const onSubmitCreate = async (data: InvoiceForm) => {
    if (!orgId) return;
    try {
      await createInvoice.mutateAsync({
        orgId,
        data,
      });
      toast({ title: "Invoice created", description: "Your invoice has been created." });
      setIsCreateOpen(false);
      form.reset();
      queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey(orgId) });
      queryClient.invalidateQueries({ queryKey: getGetOrgDashboardQueryKey(orgId) });
    } catch (e) {
      toast({ variant: "destructive", title: "Error", description: "Failed to create invoice." });
    }
  };

  const handleSend = async (invoiceId: string) => {
    if (!orgId) return;
    try {
      await sendInvoice.mutateAsync({ orgId, invoiceId });
      toast({ title: "Invoice sent", description: "Marked as sent." });
      queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey(orgId) });
    } catch (e) {
      toast({ variant: "destructive", title: "Error", description: "Failed to send invoice." });
    }
  };

  const handlePay = async (invoiceId: string, amount: string) => {
    if (!orgId) return;
    try {
      await payInvoice.mutateAsync({ 
        orgId, 
        invoiceId,
        data: {
          amount,
          paymentDate: new Date().toISOString().split('T')[0],
        }
      });
      toast({ title: "Payment recorded", description: "Invoice marked as paid." });
      queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey(orgId) });
      queryClient.invalidateQueries({ queryKey: getGetOrgDashboardQueryKey(orgId) });
    } catch (e) {
      toast({ variant: "destructive", title: "Error", description: "Failed to record payment." });
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

  const invoices = invoicesData?.invoices || [];
  const revenueAccounts = accountsData?.accounts?.filter(a => a.type === "revenue") || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Invoices</h1>
          <p className="text-muted-foreground mt-1">Manage what you're owed.</p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="w-4 h-4" />
              New Invoice
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Create Invoice</DialogTitle>
              <DialogDescription>
                Create a new invoice to track owed revenue.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmitCreate)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="customer"
                  render={({ field }) => (
                    <FormItem>
                      <Label>Customer Name</Label>
                      <FormControl>
                        <Input placeholder="Acme Corp" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="invoiceNumber"
                    render={({ field }) => (
                      <FormItem>
                        <Label>Invoice # (Optional)</Label>
                        <FormControl>
                          <Input placeholder="INV-001" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="amount"
                    render={({ field }) => (
                      <FormItem>
                        <Label>Amount</Label>
                        <FormControl>
                          <div className="relative">
                            <span className="absolute left-3 top-2.5 text-muted-foreground text-sm">$</span>
                            <Input placeholder="0.00" className="pl-6" {...field} />
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="invoiceDate"
                    render={({ field }) => (
                      <FormItem>
                        <Label>Date</Label>
                        <FormControl>
                          <Input type="date" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="dueDate"
                    render={({ field }) => (
                      <FormItem>
                        <Label>Due Date</Label>
                        <FormControl>
                          <Input type="date" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                {revenueAccounts.length > 0 && (
                  <FormField
                    control={form.control}
                    name="revenueAccountId"
                    render={({ field }) => (
                      <FormItem>
                        <Label>Revenue Account (Optional)</Label>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select account" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {revenueAccounts.map((acc) => (
                              <SelectItem key={acc.id} value={acc.id}>
                                {acc.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
                <DialogFooter>
                  <Button type="submit" disabled={createInvoice.isPending}>
                    {createInvoice.isPending ? "Creating..." : "Save Invoice"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="shadow-sm border-border">
        <CardContent className="p-0">
          {invoices.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <FileText className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p>No invoices found. Create your first one to get started.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {invoices.map((inv) => (
                <div key={inv.id} className="p-4 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/30 transition-colors">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-lg">{inv.customer}</span>
                      <Badge variant={inv.status === 'paid' ? 'secondary' : inv.sentAt ? 'default' : 'outline'} className="ml-2">
                        {inv.status === 'paid' ? 'paid' : inv.sentAt ? 'sent' : 'open'}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <span>{inv.invoiceNumber || "No number"}</span>
                      <span>•</span>
                      <span>Due {format(new Date(inv.dueDate), "MMM d, yyyy")}</span>
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-between sm:justify-end gap-6 sm:w-1/3">
                    <div className="text-right">
                      <div className="font-serif text-lg">${inv.amount}</div>
                      <div className="text-xs text-muted-foreground">
                        ${inv.outstanding} outstanding
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      {!inv.sentAt && (
                        <Button 
                          size="sm" 
                          variant="outline" 
                          onClick={() => handleSend(inv.id)}
                          disabled={sendInvoice.isPending}
                        >
                          <Send className="w-4 h-4 mr-2" />
                          Send
                        </Button>
                      )}
                      {inv.status === 'open' && (
                        <Button 
                          size="sm" 
                          onClick={() => handlePay(inv.id, inv.outstanding)}
                          disabled={payInvoice.isPending}
                        >
                          <DollarSign className="w-4 h-4 mr-2" />
                          Record Pay
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
