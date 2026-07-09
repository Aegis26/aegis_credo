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
import { Card, CardContent } from "@/components/ui/card";
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
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Bills</h1>
          <p className="text-muted-foreground mt-1">Track and pay what you owe.</p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="w-4 h-4" />
              New Bill
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Record Bill</DialogTitle>
              <DialogDescription>Record a vendor bill into accounts payable.</DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmitCreate)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="vendor"
                  render={({ field }) => (
                    <FormItem>
                      <Label>Vendor</Label>
                      <FormControl>
                        <Input placeholder="Power Co" {...field} />
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
                        <Label>Bill # (Optional)</Label>
                        <FormControl>
                          <Input placeholder="U-1" {...field} />
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
                    name="billDate"
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
                <FormField
                  control={form.control}
                  name="expenseAccountId"
                  render={({ field }) => (
                    <FormItem>
                      <Label>Expense Account</Label>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select account" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {expenseAccounts.map((acc) => (
                            <SelectItem key={acc.id} value={acc.id}>
                              {acc.code} · {acc.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter>
                  <Button type="submit" disabled={createBill.isPending}>
                    {createBill.isPending ? "Recording..." : "Save Bill"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="shadow-sm border-border">
        <CardContent className="p-0">
          {bills.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Receipt className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p>No bills yet. Record your first one to get started.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {bills.map((bill) => (
                <div key={bill.id} className="p-4 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/30 transition-colors">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-lg">{bill.vendor}</span>
                      <Badge variant={bill.status === "paid" ? "secondary" : "outline"} className="ml-2">
                        {bill.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <span>{bill.billNumber || "No number"}</span>
                      <span>•</span>
                      <span>Due {format(new Date(bill.dueDate), "MMM d, yyyy")}</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between sm:justify-end gap-6 sm:w-1/3">
                    <div className="text-right">
                      <div className="font-serif text-lg">${bill.amount}</div>
                      <div className="text-xs text-muted-foreground">${bill.outstanding} outstanding</div>
                    </div>
                    {bill.status !== "paid" && (
                      <Button size="sm" onClick={() => handlePay(bill.id, bill.outstanding)} disabled={payBill.isPending}>
                        <DollarSign className="w-4 h-4 mr-2" />
                        Pay
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
