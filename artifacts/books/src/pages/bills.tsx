import { useState } from "react";
import { useCurrentOrg } from "@/hooks/use-current-org";
import {
  useListBills,
  useCreateBill,
  usePayBill,
  useListAccounts,
  getListBillsQueryKey,
  getGetOrgDashboardQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
import { Receipt, DollarSign, Plus } from "lucide-react";

const billSchema = z.object({
  vendor: z.string().min(1, "Vendor name is required"),
  billNumber: z.string().optional(),
  billDate: z.string().min(1, "Bill date is required"),
  dueDate: z.string().min(1, "Due date is required"),
  amount: z.string().min(1, "Amount is required"),
  expenseAccountId: z.string().min(1, "Expense account is required"),
});

type BillForm = z.infer<typeof billSchema>;

export default function Bills() {
  const { orgId } = useCurrentOrg();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const { data: billsData, isLoading } = useListBills(orgId || "", {
    query: { enabled: !!orgId, queryKey: getListBillsQueryKey(orgId || "") },
  });
  const { data: accountsData } = useListAccounts(orgId || "", {
    query: { enabled: !!orgId, queryKey: ["accounts", orgId] },
  });

  const createBill = useCreateBill();
  const payBill = usePayBill();

  const form = useForm<BillForm>({
    resolver: zodResolver(billSchema),
    defaultValues: {
      vendor: "",
      billNumber: "",
      billDate: new Date().toISOString().split("T")[0],
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      amount: "",
      expenseAccountId: "",
    },
  });

  const onSubmitCreate = async (data: BillForm) => {
    if (!orgId) return;
    try {
      await createBill.mutateAsync({ orgId, data });
      toast({ title: "Bill recorded", description: "Posted Dr expense / Cr A/P." });
      setIsCreateOpen(false);
      form.reset();
      queryClient.invalidateQueries({ queryKey: getListBillsQueryKey(orgId) });
      queryClient.invalidateQueries({ queryKey: getGetOrgDashboardQueryKey(orgId) });
    } catch {
      toast({ variant: "destructive", title: "Error", description: "Failed to record bill." });
    }
  };

  const handlePay = async (billId: string, amount: string) => {
    if (!orgId) return;
    try {
      await payBill.mutateAsync({
        orgId,
        billId,
        data: { amount, paymentDate: new Date().toISOString().split("T")[0] },
      });
      toast({ title: "Payment recorded", description: "Posted Dr A/P / Cr cash." });
      queryClient.invalidateQueries({ queryKey: getListBillsQueryKey(orgId) });
      queryClient.invalidateQueries({ queryKey: getGetOrgDashboardQueryKey(orgId) });
    } catch {
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

  const bills = billsData?.bills || [];
  const expenseAccounts = accountsData?.accounts?.filter((a) => a.type === "expense") || [];

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-semibold tracking-tight text-foreground">Bills</h1>
          <p className="text-muted-foreground mt-1">Track and manage payables securely.</p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90">
              <Plus className="w-4 h-4" />
              Log Bill
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px] bg-card border-border">
            <DialogHeader>
              <DialogTitle className="text-foreground">Record Bill</DialogTitle>
              <DialogDescription className="text-muted-foreground">Log a vendor bill into accounts payable.</DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmitCreate)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="vendor"
                  render={({ field }) => (
                    <FormItem>
                      <Label className="text-foreground">Vendor</Label>
                      <FormControl>
                        <Input placeholder="Service Provider LLC" className="bg-input/50 border-border focus:border-primary" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="billNumber"
                    render={({ field }) => (
                      <FormItem>
                        <Label className="text-foreground">Bill # (Optional)</Label>
                        <FormControl>
                          <Input placeholder="B-101" className="bg-input/50 border-border focus:border-primary font-mono text-sm" {...field} />
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
                        <Label className="text-foreground">Amount</Label>
                        <FormControl>
                          <div className="relative">
                            <span className="absolute left-3 top-2.5 text-muted-foreground text-sm font-mono">$</span>
                            <Input placeholder="0.00" className="pl-6 bg-input/50 border-border focus:border-primary font-mono text-sm" {...field} />
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
                    name="billDate"
                    render={({ field }) => (
                      <FormItem>
                        <Label className="text-foreground">Date</Label>
                        <FormControl>
                          <Input type="date" className="bg-input/50 border-border focus:border-primary" {...field} />
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
                        <Label className="text-foreground">Due Date</Label>
                        <FormControl>
                          <Input type="date" className="bg-input/50 border-border focus:border-primary" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="expenseAccountId"
                  render={({ field }) => (
                    <FormItem>
                      <Label className="text-foreground">Expense Account</Label>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger className="bg-input/50 border-border focus:border-primary">
                            <SelectValue placeholder="Select account" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="bg-card border-border">
                          {expenseAccounts.map((acc) => (
                            <SelectItem key={acc.id} value={acc.id}>
                              <span className="font-mono text-muted-foreground text-xs mr-2">{acc.code}</span>
                              {acc.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter className="pt-4 border-t border-border mt-2">
                  <Button type="submit" className="w-full sm:w-auto bg-primary text-primary-foreground hover:bg-primary/90" disabled={createBill.isPending}>
                    {createBill.isPending ? "Recording..." : "Save Bill"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="shadow-none border-border bg-card">
        <CardContent className="p-0">
          {bills.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground bg-accent/20 m-6 rounded-md border border-border border-dashed">
              <Receipt className="w-12 h-12 mx-auto mb-3 opacity-40 text-primary" />
              <p className="text-lg font-medium text-foreground mb-1">No recorded payables.</p>
              <p className="text-sm">Log your first vendor bill to track liabilities.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {bills.map((bill) => (
                <div key={bill.id} className="p-4 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-accent/30 transition-colors bg-background">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-semibold text-lg text-foreground">{bill.vendor}</span>
                      <Badge 
                        variant={bill.status === "paid" ? "secondary" : "outline"} 
                        className={`ml-2 text-[10px] uppercase tracking-wider font-bold ${
                          bill.status === "paid" ? "bg-accent text-muted-foreground border-transparent" :
                          "bg-destructive/20 text-destructive border-transparent"
                        }`}
                      >
                        {bill.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-4 text-xs font-mono text-muted-foreground">
                      <span>{bill.billNumber || "No number"}</span>
                      <span>•</span>
                      <span>Due {format(new Date(bill.dueDate), "MMM d, yyyy")}</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between sm:justify-end gap-6 sm:w-1/3">
                    <div className="text-right">
                      <div className="font-serif text-xl text-foreground">${bill.amount}</div>
                      <div className="text-xs font-mono text-muted-foreground mt-1">${bill.outstanding} outst.</div>
                    </div>
                    {bill.status !== "paid" && (
                      <Button 
                        size="sm" 
                        onClick={() => handlePay(bill.id, bill.outstanding)} 
                        disabled={payBill.isPending}
                        className="bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground border-primary/20"
                        variant="outline"
                      >
                        <DollarSign className="w-3.5 h-3.5 mr-1" />
                        Execute Pay
                      </Button>
                    )}
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
