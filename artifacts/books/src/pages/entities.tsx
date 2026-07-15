import { useState } from "react";
import {
  useListGroups,
  useCreateGroup,
  useAddOrgToGroup,
  useGetConsolidatedProfitAndLossReport,
  useGetConsolidatedBalanceSheetReport,
  useGetConsolidatedTrialBalanceReport,
  getListGroupsQueryKey,
  getGetConsolidatedProfitAndLossReportQueryKey,
  getGetConsolidatedBalanceSheetReportQueryKey,
  getGetConsolidatedTrialBalanceReportQueryKey,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Building2, Network, Plus } from "lucide-react";

export default function Entities() {
  const { orgId, orgs } = useCurrentOrg();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [addOrgOpen, setAddOrgOpen] = useState(false);
  const [addOrgId, setAddOrgId] = useState("");

  const { data: groupsData, isLoading } = useListGroups({
    query: { queryKey: getListGroupsQueryKey() },
  });

  const createGroup = useCreateGroup();
  const addOrgToGroup = useAddOrgToGroup();

  const groups = groupsData?.groups ?? [];
  const activeGroupId = selectedGroupId ?? groups[0]?.id ?? null;
  const activeGroup = groups.find((g) => g.id === activeGroupId) ?? null;

  const { data: pnl, isLoading: pnlLoading } = useGetConsolidatedProfitAndLossReport(
    activeGroupId || "",
    {
      query: {
        enabled: !!activeGroupId,
        queryKey: getGetConsolidatedProfitAndLossReportQueryKey(activeGroupId || ""),
      },
    },
  );

  const { data: bs, isLoading: bsLoading } = useGetConsolidatedBalanceSheetReport(
    activeGroupId || "",
    {
      query: {
        enabled: !!activeGroupId,
        queryKey: getGetConsolidatedBalanceSheetReportQueryKey(activeGroupId || ""),
      },
    },
  );

  const { data: tb, isLoading: tbLoading } = useGetConsolidatedTrialBalanceReport(
    activeGroupId || "",
    {
      query: {
        enabled: !!activeGroupId,
        queryKey: getGetConsolidatedTrialBalanceReportQueryKey(activeGroupId || ""),
      },
    },
  );

  const handleCreate = async () => {
    if (!groupName.trim()) return;
    try {
      const group = await createGroup.mutateAsync({ data: { name: groupName.trim() } });
      // Refetch the group list BEFORE closing the dialog so the new group is
      // visible immediately (same pattern as the Create Organization flow).
      await queryClient.invalidateQueries({ queryKey: getListGroupsQueryKey() });
      toast({ title: "Group created", description: `${group.name} is ready.` });
      setGroupName("");
      setCreateOpen(false);
      setSelectedGroupId(group.id);
    } catch {
      toast({ variant: "destructive", title: "Error", description: "Could not create the group." });
    }
  };

  const handleAddOrg = async () => {
    if (!activeGroupId || !addOrgId) return;
    try {
      await addOrgToGroup.mutateAsync({ groupId: activeGroupId, data: { orgId: addOrgId } });
      await queryClient.invalidateQueries({ queryKey: getListGroupsQueryKey() });
      toast({ title: "Entity added", description: "The org is now part of this group." });
      setAddOrgId("");
      setAddOrgOpen(false);
    } catch {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Could not add this entity. You need members.manage on the org.",
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="w-8 h-8 text-primary" />
      </div>
    );
  }

  const memberOrgIds = new Set(activeGroup?.orgs.map((o) => o.orgId) ?? []);
  const addableOrgs = orgs.filter((o) => !memberOrgIds.has(o.id));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Entities</h1>
          <p className="text-muted-foreground mt-1">
            Consolidated reporting across a group of organizations, with intercompany eliminations.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="w-4 h-4" />
              New group
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Create a group</DialogTitle>
              <DialogDescription>Group organizations for consolidated reporting.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label>Group name</Label>
              <Input
                placeholder="Acme Holdings"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button onClick={handleCreate} disabled={createGroup.isPending || !groupName.trim()}>
                {createGroup.isPending ? "Creating..." : "Create group"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {groups.length === 0 ? (
        <Card className="shadow-sm">
          <CardContent className="text-center py-16 text-muted-foreground">
            <Network className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p>No groups yet. Create one to consolidate multiple entities.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {groups.map((g) => (
              <Button
                key={g.id}
                variant={g.id === activeGroupId ? "default" : "outline"}
                size="sm"
                onClick={() => setSelectedGroupId(g.id)}
                className="gap-2"
              >
                <Network className="w-4 h-4" />
                {g.name}
                <Badge variant="secondary" className="ml-1">
                  {g.orgs.length}
                </Badge>
              </Button>
            ))}
          </div>

          {activeGroup && (
            <Card className="shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Building2 className="w-5 h-5 text-primary" />
                    {activeGroup.name} — Member entities
                  </CardTitle>
                  <CardDescription>Organizations included in this consolidation.</CardDescription>
                </div>
                <Dialog open={addOrgOpen} onOpenChange={setAddOrgOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-2">
                      <Plus className="w-4 h-4" />
                      Add entity
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                      <DialogTitle>Add an entity</DialogTitle>
                      <DialogDescription>
                        Add one of your organizations to {activeGroup.name}.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2">
                      <Label>Organization</Label>
                      <Select value={addOrgId} onValueChange={setAddOrgId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select an organization" />
                        </SelectTrigger>
                        <SelectContent>
                          {addableOrgs.map((o) => (
                            <SelectItem key={o.id} value={o.id}>
                              {o.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <DialogFooter>
                      <Button onClick={handleAddOrg} disabled={addOrgToGroup.isPending || !addOrgId}>
                        {addOrgToGroup.isPending ? "Adding..." : "Add entity"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardHeader>
              <CardContent>
                {activeGroup.orgs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No entities yet. Add one to consolidate.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {activeGroup.orgs.map((o) => (
                      <Badge key={o.orgId} variant="outline" className="text-sm py-1">
                        {o.name}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Tabs defaultValue="pnl" className="w-full">
            <TabsList className="mb-4">
              <TabsTrigger value="pnl">Consolidated P&L</TabsTrigger>
              <TabsTrigger value="bs">Consolidated Balance Sheet</TabsTrigger>
              <TabsTrigger value="tb">Trial Balance & Eliminations</TabsTrigger>
            </TabsList>

            <TabsContent value="pnl">
              <Card className="shadow-sm">
                <CardHeader>
                  <CardTitle>Consolidated Profit & Loss</CardTitle>
                  <CardDescription>Combined across all member entities</CardDescription>
                </CardHeader>
                <CardContent>
                  {pnlLoading ? (
                    <div className="flex justify-center py-8">
                      <Spinner />
                    </div>
                  ) : pnl ? (
                    <div className="space-y-3">
                      <div className="flex justify-between text-sm py-1">
                        <span>Revenue</span>
                        <span>${pnl.revenue}</span>
                      </div>
                      <div className="flex justify-between text-sm py-1">
                        <span>Expenses</span>
                        <span>${pnl.expenses}</span>
                      </div>
                      <div className="flex justify-between text-lg font-serif font-bold pt-3 border-t-2 border-primary">
                        <span>Net Income</span>
                        <span className={pnl.netIncome.startsWith("-") ? "text-destructive" : "text-green-700"}>
                          ${pnl.netIncome}
                        </span>
                      </div>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="bs">
              <Card className="shadow-sm">
                <CardHeader>
                  <CardTitle>Consolidated Balance Sheet</CardTitle>
                  <CardDescription>Combined across all member entities</CardDescription>
                </CardHeader>
                <CardContent>
                  {bsLoading ? (
                    <div className="flex justify-center py-8">
                      <Spinner />
                    </div>
                  ) : bs ? (
                    <div className="space-y-3">
                      <div className="flex justify-between text-sm py-1">
                        <span>Assets</span>
                        <span>${bs.assets}</span>
                      </div>
                      <div className="flex justify-between text-sm py-1">
                        <span>Liabilities</span>
                        <span>${bs.liabilities}</span>
                      </div>
                      <div className="flex justify-between text-sm py-1">
                        <span>Equity</span>
                        <span>${bs.equity}</span>
                      </div>
                      <div className="flex justify-between text-sm py-1 text-muted-foreground">
                        <span>Current Net Income</span>
                        <span>${bs.netIncome}</span>
                      </div>
                      <div className="flex justify-between text-sm font-semibold pt-2 border-t">
                        <span>Total Equity</span>
                        <span>${bs.equityWithIncome}</span>
                      </div>
                      <div className="flex justify-between text-lg font-serif font-bold pt-3 border-t-2 border-primary">
                        <span>Balances</span>
                        <Badge variant={bs.balances ? "secondary" : "destructive"}>
                          {bs.balances ? "In balance" : "Out of balance"}
                        </Badge>
                      </div>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="tb">
              <Card className="shadow-sm">
                <CardHeader>
                  <CardTitle>Trial Balance & Intercompany Eliminations</CardTitle>
                  <CardDescription>
                    Combined balances, elimination entries, and the consolidated result.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {tbLoading ? (
                    <div className="flex justify-center py-8">
                      <Spinner />
                    </div>
                  ) : tb ? (
                    <div className="space-y-8">
                      {tb.eliminations.length > 0 && (
                        <div>
                          <h3 className="text-sm font-medium uppercase text-muted-foreground mb-3 border-b pb-2">
                            Eliminations
                          </h3>
                          <div className="overflow-x-auto">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Code</TableHead>
                                  <TableHead>Account</TableHead>
                                  <TableHead className="text-right">Debit</TableHead>
                                  <TableHead className="text-right">Credit</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {tb.eliminations.map((row) => (
                                  <TableRow key={`elim-${row.code}`}>
                                    <TableCell className="font-mono text-xs">{row.code}</TableCell>
                                    <TableCell>{row.name}</TableCell>
                                    <TableCell className="text-right">${row.debit}</TableCell>
                                    <TableCell className="text-right">${row.credit}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        </div>
                      )}

                      <div>
                        <h3 className="text-sm font-medium uppercase text-muted-foreground mb-3 border-b pb-2">
                          Consolidated
                        </h3>
                        <div className="overflow-x-auto">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Code</TableHead>
                                <TableHead>Account</TableHead>
                                <TableHead>Type</TableHead>
                                <TableHead className="text-right">Debit</TableHead>
                                <TableHead className="text-right">Credit</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {tb.consolidated.map((row) => (
                                <TableRow key={`cons-${row.code}`}>
                                  <TableCell className="font-mono text-xs">{row.code}</TableCell>
                                  <TableCell>{row.name}</TableCell>
                                  <TableCell className="capitalize text-muted-foreground text-xs">
                                    {row.type}
                                  </TableCell>
                                  <TableCell className="text-right">${row.debit}</TableCell>
                                  <TableCell className="text-right">${row.credit}</TableCell>
                                </TableRow>
                              ))}
                              <TableRow className="font-bold bg-muted/20">
                                <TableCell colSpan={3}>Total</TableCell>
                                <TableCell className="text-right">${tb.totalDebit}</TableCell>
                                <TableCell className="text-right">${tb.totalCredit}</TableCell>
                              </TableRow>
                            </TableBody>
                          </Table>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
