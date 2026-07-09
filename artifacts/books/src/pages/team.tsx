import { useState } from "react";
import { useCurrentOrg } from "@/hooks/use-current-org";
import {
  useListMembers,
  useAddMember,
  useRevokeMember,
  useInviteAccountant,
  getListMembersQueryKey,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { UserPlus, Briefcase, Users, Ban } from "lucide-react";

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  staff: "Staff",
  view_only: "View only",
  accountant: "Accountant",
};

const memberSchema = z.object({
  email: z.string().min(1, "Email is required"),
  name: z.string().optional(),
  role: z.enum(["staff", "view_only"]),
});
type MemberForm = z.infer<typeof memberSchema>;

const accountantSchema = z.object({
  email: z.string().min(1, "Email is required"),
  name: z.string().optional(),
});
type AccountantForm = z.infer<typeof accountantSchema>;

function initials(name: string | null, email: string): string {
  const base = name?.trim() || email;
  return base.slice(0, 2).toUpperCase();
}

export default function Team() {
  const { orgId, orgs } = useCurrentOrg();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [memberOpen, setMemberOpen] = useState(false);
  const [accountantOpen, setAccountantOpen] = useState(false);

  const role = orgs.find((o) => o.id === orgId)?.role ?? null;
  const canManage = role === "owner";

  const { data, isLoading } = useListMembers(orgId || "", {
    query: { enabled: !!orgId, queryKey: getListMembersQueryKey(orgId || "") },
  });

  const addMember = useAddMember();
  const inviteAccountant = useInviteAccountant();
  const revokeMember = useRevokeMember();

  const memberForm = useForm<MemberForm>({
    resolver: zodResolver(memberSchema),
    defaultValues: { email: "", name: "", role: "staff" },
  });
  const accountantForm = useForm<AccountantForm>({
    resolver: zodResolver(accountantSchema),
    defaultValues: { email: "", name: "" },
  });

  const refresh = () =>
    orgId && queryClient.invalidateQueries({ queryKey: getListMembersQueryKey(orgId) });

  const onAddMember = async (values: MemberForm) => {
    if (!orgId) return;
    try {
      await addMember.mutateAsync({ orgId, data: values });
      toast({ title: "Member invited", description: `${values.email} added as ${ROLE_LABELS[values.role]}.` });
      setMemberOpen(false);
      memberForm.reset();
      refresh();
    } catch {
      toast({ variant: "destructive", title: "Error", description: "Could not invite this member." });
    }
  };

  const onInviteAccountant = async (values: AccountantForm) => {
    if (!orgId) return;
    try {
      await inviteAccountant.mutateAsync({ orgId, data: values });
      toast({ title: "Accountant invited", description: `${values.email} now has scoped, revocable access.` });
      setAccountantOpen(false);
      accountantForm.reset();
      refresh();
    } catch {
      toast({ variant: "destructive", title: "Error", description: "Could not invite this accountant." });
    }
  };

  const handleRevoke = async (userId: string, email: string) => {
    if (!orgId) return;
    try {
      await revokeMember.mutateAsync({ orgId, userId });
      toast({ title: "Access revoked", description: `${email} can no longer access this org.` });
      refresh();
    } catch {
      toast({ variant: "destructive", title: "Error", description: "Could not revoke access." });
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

  const all = data?.members || [];
  const users = all.filter((m) => m.role !== "accountant");
  const accountants = all.filter((m) => m.role === "accountant");

  const MemberRow = ({ m }: { m: (typeof all)[number] }) => (
    <div className="p-4 sm:px-6 flex items-center justify-between gap-4 hover:bg-muted/30 transition-colors">
      <div className="flex items-center gap-3">
        <Avatar className="h-9 w-9">
          <AvatarFallback className="bg-primary/10 text-primary text-xs">
            {initials(m.name, m.email)}
          </AvatarFallback>
        </Avatar>
        <div>
          <div className="font-medium">{m.name || m.email}</div>
          {m.name && <div className="text-sm text-muted-foreground">{m.email}</div>}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Badge variant="outline">{ROLE_LABELS[m.role] ?? m.role}</Badge>
        {m.active ? (
          <Badge variant="secondary">Active</Badge>
        ) : (
          <Badge variant="destructive">Revoked</Badge>
        )}
        {canManage && m.active && m.role !== "owner" && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => handleRevoke(m.userId, m.email)}
            disabled={revokeMember.isPending}
          >
            <Ban className="w-4 h-4 mr-1" />
            Revoke
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Team</h1>
        <p className="text-muted-foreground mt-1">
          Manage who can access your books and invite your accountant.
        </p>
      </div>

      {!canManage && (
        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          Only owners can invite or revoke members. You have {ROLE_LABELS[role ?? ""] ?? "limited"} access.
        </div>
      )}

      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users" className="gap-2">
            <Users className="w-4 h-4" />
            Users
          </TabsTrigger>
          <TabsTrigger value="accountants" className="gap-2">
            <Briefcase className="w-4 h-4" />
            Accountants
          </TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="mt-4">
          <Card className="shadow-sm border-border">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Users</CardTitle>
                <CardDescription>People on your team with a role in this org.</CardDescription>
              </div>
              {canManage && (
                <Dialog open={memberOpen} onOpenChange={setMemberOpen}>
                  <DialogTrigger asChild>
                    <Button className="gap-2">
                      <UserPlus className="w-4 h-4" />
                      Invite user
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                      <DialogTitle>Invite a user</DialogTitle>
                      <DialogDescription>Grant a teammate access with a role.</DialogDescription>
                    </DialogHeader>
                    <Form {...memberForm}>
                      <form onSubmit={memberForm.handleSubmit(onAddMember)} className="space-y-4">
                        <FormField
                          control={memberForm.control}
                          name="email"
                          render={({ field }) => (
                            <FormItem>
                              <Label>Email</Label>
                              <FormControl>
                                <Input placeholder="teammate@company.com" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={memberForm.control}
                          name="name"
                          render={({ field }) => (
                            <FormItem>
                              <Label>Name (Optional)</Label>
                              <FormControl>
                                <Input placeholder="Jane Doe" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={memberForm.control}
                          name="role"
                          render={({ field }) => (
                            <FormItem>
                              <Label>Role</Label>
                              <Select onValueChange={field.onChange} value={field.value}>
                                <FormControl>
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  <SelectItem value="staff">Staff — can post transactions</SelectItem>
                                  <SelectItem value="view_only">View only — read reports</SelectItem>
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <DialogFooter>
                          <Button type="submit" disabled={addMember.isPending}>
                            {addMember.isPending ? "Inviting..." : "Send invite"}
                          </Button>
                        </DialogFooter>
                      </form>
                    </Form>
                  </DialogContent>
                </Dialog>
              )}
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {users.map((m) => (
                  <MemberRow key={m.userId} m={m} />
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="accountants" className="mt-4">
          <Card className="shadow-sm border-border">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Accountants</CardTitle>
                <CardDescription>
                  External collaborators with scoped, revocable, audited access.
                </CardDescription>
              </div>
              {canManage && (
                <Dialog open={accountantOpen} onOpenChange={setAccountantOpen}>
                  <DialogTrigger asChild>
                    <Button className="gap-2">
                      <UserPlus className="w-4 h-4" />
                      Invite accountant
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                      <DialogTitle>Invite an accountant</DialogTitle>
                      <DialogDescription>
                        They'll see only this org, and only until you revoke access.
                      </DialogDescription>
                    </DialogHeader>
                    <Form {...accountantForm}>
                      <form onSubmit={accountantForm.handleSubmit(onInviteAccountant)} className="space-y-4">
                        <FormField
                          control={accountantForm.control}
                          name="email"
                          render={({ field }) => (
                            <FormItem>
                              <Label>Email</Label>
                              <FormControl>
                                <Input placeholder="cpa@firm.com" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={accountantForm.control}
                          name="name"
                          render={({ field }) => (
                            <FormItem>
                              <Label>Name (Optional)</Label>
                              <FormControl>
                                <Input placeholder="Firm name or contact" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <DialogFooter>
                          <Button type="submit" disabled={inviteAccountant.isPending}>
                            {inviteAccountant.isPending ? "Inviting..." : "Send invite"}
                          </Button>
                        </DialogFooter>
                      </form>
                    </Form>
                  </DialogContent>
                </Dialog>
              )}
            </CardHeader>
            <CardContent className="p-0">
              {accountants.length === 0 ? (
                <div className="text-center py-16 text-muted-foreground">
                  <Briefcase className="w-12 h-12 mx-auto mb-3 opacity-20" />
                  <p>No accountants invited yet.</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {accountants.map((m) => (
                    <MemberRow key={m.userId} m={m} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
