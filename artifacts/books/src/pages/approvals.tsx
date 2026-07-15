import { useState } from "react";
import {
  useListOrgApprovals,
  useDecideOrgApproval,
  useListApprovalRules,
  useCreateOrgApprovalRule,
  useGetApprovalAudit,
  getListOrgApprovalsQueryKey,
  getListApprovalRulesQueryKey,
  getGetApprovalAuditQueryKey,
} from "@workspace/api-client-react";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { Check, X, Plus, ShieldCheck, History } from "lucide-react";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "default",
  approved: "secondary",
  rejected: "destructive",
};

export default function Approvals() {
  const { orgId, orgs } = useCurrentOrg();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const role = orgs.find((o) => o.id === orgId)?.role ?? null;
  const canManage = role === "owner";

  const [ruleOpen, setRuleOpen] = useState(false);
  const [ruleEntityType, setRuleEntityType] = useState("bill");
  const [ruleThreshold, setRuleThreshold] = useState("");
  const [ruleActive, setRuleActive] = useState(true);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const { data: approvalsData, isLoading } = useListOrgApprovals(
    orgId || "",
    undefined,
    {
      query: {
        enabled: !!orgId,
        queryKey: getListOrgApprovalsQueryKey(orgId || "", undefined),
      },
    },
  );

  const { data: rulesData, isLoading: rulesLoading } = useListApprovalRules(orgId || "", {
    query: { enabled: !!orgId, queryKey: getListApprovalRulesQueryKey(orgId || "") },
  });

  const { data: auditData, isLoading: auditLoading } = useGetApprovalAudit(orgId || "", {
    query: { enabled: !!orgId, queryKey: getGetApprovalAuditQueryKey(orgId || "") },
  });

  const decide = useDecideOrgApproval();
  const createRule = useCreateOrgApprovalRule();

  const refresh = () => {
    if (!orgId) return;
    queryClient.invalidateQueries({ queryKey: getListOrgApprovalsQueryKey(orgId, undefined) });
    queryClient.invalidateQueries({ queryKey: getGetApprovalAuditQueryKey(orgId) });
  };

  const handleDecide = async (approvalId: string, decision: "approved" | "rejected") => {
    if (!orgId) return;
    try {
      await decide.mutateAsync({
        orgId,
        approvalId,
        data: { decision, note: notes[approvalId]?.trim() || undefined },
      });
      toast({
        title: decision === "approved" ? "Approved" : "Rejected",
        description: `Approval ${decision}.`,
      });
      setNotes((prev) => {
        const next = { ...prev };
        delete next[approvalId];
        return next;
      });
      refresh();
    } catch {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Could not record the decision. You need members.manage.",
      });
    }
  };

  const handleCreateRule = async () => {
    if (!orgId || !ruleEntityType.trim() || !ruleThreshold.trim()) return;
    try {
      await createRule.mutateAsync({
        orgId,
        data: { entityType: ruleEntityType.trim(), threshold: ruleThreshold.trim(), active: ruleActive },
      });
      toast({ title: "Rule created", description: "Approval rule saved." });
      setRuleThreshold("");
      setRuleOpen(false);
      queryClient.invalidateQueries({ queryKey: getListApprovalRulesQueryKey(orgId) });
    } catch {
      toast({ variant: "destructive", title: "Error", description: "Could not create the rule." });
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

  const approvals = approvalsData?.approvals ?? [];
  const pending = approvals.filter((a) => a.status === "pending");
  const rules = rulesData?.rules ?? [];
  const events = auditData?.events ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Approvals</h1>
        <p className="text-muted-foreground mt-1">
          Review pending approvals, configure rules, and audit every decision.
        </p>
      </div>

      <Tabs defaultValue="queue" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="queue" className="gap-2">
            <ShieldCheck className="w-4 h-4" />
            Queue
            {pending.length > 0 && (
              <Badge variant="secondary" className="ml-1">
                {pending.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="rules" className="gap-2">
            <Plus className="w-4 h-4" />
            Rules
          </TabsTrigger>
          <TabsTrigger value="audit" className="gap-2">
            <History className="w-4 h-4" />
            Audit trail
          </TabsTrigger>
        </TabsList>

        <TabsContent value="queue">
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle>Approval queue</CardTitle>
              <CardDescription>Transactions awaiting a decision.</CardDescription>
            </CardHeader>
            <CardContent>
              {approvals.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <ShieldCheck className="w-12 h-12 mx-auto mb-3 opacity-20" />
                  <p>No approvals to show.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {approvals.map((a) => (
                    <div key={a.id} className="border rounded-lg p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium capitalize">{a.entityType}</span>
                            <Badge variant={STATUS_VARIANT[a.status] ?? "outline"}>{a.status}</Badge>
                          </div>
                          <p className="text-sm text-muted-foreground mt-1">
                            Amount: <span className="font-medium">${a.amount}</span>
                          </p>
                          {a.note && (
                            <p className="text-sm text-muted-foreground mt-1">Note: {a.note}</p>
                          )}
                          <p className="text-xs text-muted-foreground mt-1">
                            Requested {format(new Date(a.createdAt), "MMM d, yyyy")}
                          </p>
                        </div>
                        {a.status === "pending" && canManage && (
                          <div className="flex flex-col gap-2 min-w-[220px]">
                            <Input
                              placeholder="Note (optional)"
                              value={notes[a.id] || ""}
                              onChange={(e) => setNotes((prev) => ({ ...prev, [a.id]: e.target.value }))}
                            />
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                className="flex-1 gap-1"
                                onClick={() => handleDecide(a.id, "approved")}
                                disabled={decide.isPending}
                              >
                                <Check className="w-4 h-4" />
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                className="flex-1 gap-1"
                                onClick={() => handleDecide(a.id, "rejected")}
                                disabled={decide.isPending}
                              >
                                <X className="w-4 h-4" />
                                Reject
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rules">
          <Card className="shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Approval rules</CardTitle>
                <CardDescription>
                  Transactions above a threshold require approval before they post.
                </CardDescription>
              </div>
              {canManage && (
                <Dialog open={ruleOpen} onOpenChange={setRuleOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" className="gap-2">
                      <Plus className="w-4 h-4" />
                      New rule
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                      <DialogTitle>Create an approval rule</DialogTitle>
                      <DialogDescription>Set a threshold for an entity type.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label>Entity type</Label>
                        <Input
                          placeholder="bill"
                          value={ruleEntityType}
                          onChange={(e) => setRuleEntityType(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Threshold</Label>
                        <Input
                          placeholder="1000.00"
                          value={ruleThreshold}
                          onChange={(e) => setRuleThreshold(e.target.value)}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label>Active</Label>
                        <Switch checked={ruleActive} onCheckedChange={setRuleActive} />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button
                        onClick={handleCreateRule}
                        disabled={createRule.isPending || !ruleThreshold.trim() || !ruleEntityType.trim()}
                      >
                        {createRule.isPending ? "Saving..." : "Save rule"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}
            </CardHeader>
            <CardContent>
              {rulesLoading ? (
                <div className="flex justify-center py-8">
                  <Spinner />
                </div>
              ) : rules.length === 0 ? (
                <p className="text-sm text-muted-foreground">No rules configured.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Entity type</TableHead>
                      <TableHead className="text-right">Threshold</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rules.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="capitalize">{r.entityType}</TableCell>
                        <TableCell className="text-right">${r.threshold}</TableCell>
                        <TableCell>
                          <Badge variant={r.active ? "secondary" : "outline"}>
                            {r.active ? "Active" : "Inactive"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {format(new Date(r.createdAt), "MMM d, yyyy")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit">
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle>Audit trail</CardTitle>
              <CardDescription>Every approval and rule change, in order.</CardDescription>
            </CardHeader>
            <CardContent>
              {auditLoading ? (
                <div className="flex justify-center py-8">
                  <Spinner />
                </div>
              ) : events.length === 0 ? (
                <p className="text-sm text-muted-foreground">No audit events yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Actor</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Entity</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                          {format(new Date(e.createdAt), "MMM d, yyyy HH:mm")}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{e.actor}</TableCell>
                        <TableCell>{e.action}</TableCell>
                        <TableCell className="capitalize">{e.entity}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
