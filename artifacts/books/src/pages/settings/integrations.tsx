import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { 
  useListOrgCredentials, 
  useCreateOrgCredential, 
  useRevokeOrgCredential, 
  useRotateOrgCredential,
  getListOrgCredentialsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCurrentOrg } from "@/hooks/use-current-org";

import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";

import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";

import { useToast } from "@/hooks/use-toast";
import { Copy, MoreHorizontal, KeyRound, AlertTriangle, Blocks, RefreshCw, XCircle } from "lucide-react";

const SCOPES = [
  { id: "read:invoices", label: "Read Invoices", description: "View invoices." },
  { id: "write:invoices", label: "Write Invoices", description: "Create invoices." },
  { id: "read:gl", label: "Read General Ledger", description: "View journal entries." },
  { id: "write:gl", label: "Write General Ledger", description: "Create journal entries." },
  { id: "read:reports", label: "Read Reports", description: "View trial balance report." },
  { id: "read:customers", label: "Read Customers", description: "View customer names from invoices." },
] as const;

const createCredentialSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name must be under 100 characters"),
  notes: z.string().max(300, "Notes must be under 300 characters").optional(),
  scopes: z.array(z.string()).min(1, "At least one scope is required"),
});

function CreateCredentialDialog({ 
  orgId, 
  open, 
  onOpenChange, 
  onCreated 
}: { 
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (apiKey: string, name: string) => void;
}) {
  const { toast } = useToast();
  const createMut = useCreateOrgCredential();

  const form = useForm<z.infer<typeof createCredentialSchema>>({
    resolver: zodResolver(createCredentialSchema),
    defaultValues: {
      name: "",
      notes: "",
      scopes: [],
    }
  });

  useEffect(() => {
    if (open) {
      form.reset({ name: "", notes: "", scopes: [] });
    }
  }, [open, form]);

  const onSubmit = (values: z.infer<typeof createCredentialSchema>) => {
    createMut.mutate({
      orgId,
      data: {
        name: values.name,
        notes: values.notes,
        scopes: values.scopes as any,
      }
    }, {
      onSuccess: (data) => {
        const apiKey = data.apiKey;
        const name = data.credential.name;
        createMut.reset();
        onCreated(apiKey, name);
      },
      onError: (err) => {
        toast({
          title: "Failed to create credential",
          description: err.data?.error || err.message || "An unexpected error occurred.",
          variant: "destructive"
        });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={(val) => {
      // Prevent closing while submitting
      if (createMut.isPending) return;
      onOpenChange(val);
    }}>
      <DialogContent className="border-border sm:max-w-[600px] bg-card">
        <DialogHeader>
          <DialogTitle className="text-xl">Create API Key</DialogTitle>
          <DialogDescription>
            Configure access scopes for your new integration credential.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 mt-4">
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-6">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Zapier Integration" {...field} data-testid="input-cred-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Notes (Optional)</FormLabel>
                      <FormControl>
                        <Textarea 
                          placeholder="Describe the purpose of this key..." 
                          className="resize-none h-[120px]"
                          {...field} 
                          data-testid="input-cred-notes"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="scopes"
                render={() => (
                  <FormItem>
                    <div className="mb-4">
                      <FormLabel className="text-base text-foreground">Permissions</FormLabel>
                      <FormDescription className="text-xs">
                        Select the scopes this key will have access to.
                      </FormDescription>
                    </div>
                    <div className="flex flex-col gap-3">
                      {SCOPES.map((item) => (
                        <FormField
                          key={item.id}
                          control={form.control}
                          name="scopes"
                          render={({ field }) => {
                            const isChecked = field.value?.includes(item.id);
                            return (
                              <FormItem
                                key={item.id}
                                className={`flex flex-row items-start space-x-3 space-y-0 rounded-md border p-3 transition-colors ${isChecked ? 'bg-primary/5 border-primary/20' : 'bg-transparent border-border hover:bg-accent/50'}`}
                              >
                                <FormControl>
                                  <Checkbox
                                    checked={isChecked}
                                    onCheckedChange={(checked) => {
                                      return checked
                                        ? field.onChange([...field.value, item.id])
                                        : field.onChange(
                                            field.value?.filter(
                                              (value) => value !== item.id
                                            )
                                          )
                                    }}
                                    data-testid={`checkbox-scope-${item.id.replace(':', '-')}`}
                                  />
                                </FormControl>
                                <div className="space-y-1 leading-none">
                                  <FormLabel className="font-medium cursor-pointer text-sm">
                                    {item.label}
                                  </FormLabel>
                                  <FormDescription className="text-[11px] text-muted-foreground/80">
                                    {item.description}
                                  </FormDescription>
                                </div>
                              </FormItem>
                            )
                          }}
                        />
                      ))}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter className="border-t border-border pt-6">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={createMut.isPending} data-testid="button-cancel-create">
                Cancel
              </Button>
              <Button type="submit" disabled={createMut.isPending} data-testid="button-submit-create">
                {createMut.isPending && <Spinner className="mr-2 h-4 w-4" />}
                Generate Key
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function ShowKeyDialog({ 
  apiKey, 
  name, 
  open, 
  onOpenChange 
}: { 
  apiKey: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();

  const handleCopy = () => {
    navigator.clipboard.writeText(apiKey);
    toast({
      title: "Copied!",
      description: "API Key copied to clipboard.",
    });
  };

  return (
    <Dialog open={open} onOpenChange={(val) => {
      if (!val) {
        onOpenChange(false);
      }
    }}>
      <DialogContent className="border-border sm:max-w-md bg-card" onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="text-xl">Save your API Key</DialogTitle>
          <DialogDescription className="text-destructive font-medium mt-3 flex items-start gap-2 bg-destructive/10 p-3 rounded-md border border-destructive/20">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            Please copy this key and save it securely. You will not be able to see it again after closing this dialog!
          </DialogDescription>
        </DialogHeader>

        <div className="my-6 space-y-4">
          <div className="text-sm text-muted-foreground">
            Key generated for: <strong className="text-foreground">{name}</strong>
          </div>
          
          <div className="flex items-center space-x-2 bg-background p-3 rounded-md border border-border shadow-inner">
            <code className="text-sm font-mono flex-1 break-all text-primary" data-testid="text-api-key">{apiKey}</code>
            <Button variant="secondary" size="icon" onClick={handleCopy} className="shrink-0 hover:bg-primary hover:text-primary-foreground transition-colors" title="Copy to clipboard" data-testid="button-copy-key">
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} className="w-full" data-testid="button-close-key-dialog">
            I have saved it securely
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SettingsIntegrations() {
  const { orgId } = useCurrentOrg();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: credentialsData, isLoading, isError } = useListOrgCredentials(orgId!, {
    query: {
      enabled: !!orgId,
      queryKey: getListOrgCredentialsQueryKey(orgId!),
    }
  });

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [showKeyData, setShowKeyData] = useState<{ apiKey: string; name: string } | null>(null);

  // Ensure key data is cleared if the organization changes or component unmounts
  useEffect(() => {
    return () => setShowKeyData(null);
  }, [orgId]);

  const [rotateConfirmTarget, setRotateConfirmTarget] = useState<string | null>(null);
  const [revokeConfirmTarget, setRevokeConfirmTarget] = useState<string | null>(null);

  const rotateMut = useRotateOrgCredential();
  const revokeMut = useRevokeOrgCredential();

  const handleCreated = (apiKey: string, name: string) => {
    if (orgId) {
      queryClient.invalidateQueries({ queryKey: getListOrgCredentialsQueryKey(orgId) });
    }
    setCreateDialogOpen(false);
    setShowKeyData({ apiKey, name });
    toast({
      title: "Credential Created",
      description: "API Key has been generated successfully.",
    });
  };

  const handleRotated = (apiKey: string, name: string) => {
    if (orgId) {
      queryClient.invalidateQueries({ queryKey: getListOrgCredentialsQueryKey(orgId) });
    }
    setRotateConfirmTarget(null);
    setShowKeyData({ apiKey, name });
    toast({
      title: "Credential Rotated",
      description: "A new API Key has been generated successfully.",
    });
  };

  const handleRevoked = () => {
    if (orgId) {
      queryClient.invalidateQueries({ queryKey: getListOrgCredentialsQueryKey(orgId) });
    }
    setRevokeConfirmTarget(null);
    toast({
      title: "Credential Revoked",
      description: "The credential has been deactivated.",
    });
  };

  if (!orgId) return null;

  return (
    <div className="space-y-8 animate-in fade-in duration-500 max-w-5xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Machine Integrations</h1>
          <p className="text-muted-foreground mt-2">
            Manage API credentials for programmatic access to this workspace.
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)} className="gap-2" data-testid="button-create-credential">
          <KeyRound className="w-4 h-4" />
          Create API Key
        </Button>
      </div>

      {isLoading ? (
         <div className="space-y-4">
           <Skeleton className="h-12 w-full bg-card" />
           <Skeleton className="h-24 w-full bg-card" />
           <Skeleton className="h-24 w-full bg-card" />
         </div>
      ) : isError ? (
         <Empty className="border-border">
           <EmptyMedia variant="icon"><AlertTriangle className="text-destructive" /></EmptyMedia>
           <EmptyTitle>Error Loading Credentials</EmptyTitle>
           <EmptyDescription>Failed to load integration settings. Please try again.</EmptyDescription>
         </Empty>
      ) : credentialsData?.credentials.length === 0 ? (
         <Empty className="border-border">
           <EmptyMedia variant="icon"><Blocks className="text-muted-foreground" /></EmptyMedia>
           <EmptyTitle>No Integrations</EmptyTitle>
           <EmptyDescription>Generate an API key to allow external systems to access your workspace securely.</EmptyDescription>
           <Button onClick={() => setCreateDialogOpen(true)} variant="outline" className="mt-4 gap-2">
             <KeyRound className="w-4 h-4" /> Create your first key
           </Button>
         </Empty>
      ) : (
        <div className="rounded-md border border-border bg-card overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/30">
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="w-[300px]">Credential</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[300px]">Scopes</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last Used</TableHead>
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {credentialsData?.credentials.map((cred) => (
                <TableRow key={cred.id} className="border-border hover:bg-muted/10 group transition-colors">
                  <TableCell className="align-top py-4">
                    <div className="font-medium text-foreground text-base flex items-center gap-2">
                      {cred.name}
                    </div>
                    {cred.notes && (
                      <div className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                        {cred.notes}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="align-top py-4">
                    {cred.isActive ? (
                      <Badge variant="outline" className="bg-success/10 text-success border-success/20">Active</Badge>
                    ) : (
                      <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20">Revoked</Badge>
                    )}
                  </TableCell>
                  <TableCell className="align-top py-4">
                    <div className="flex flex-wrap gap-1.5">
                      {cred.scopes.map(scope => (
                        <Badge key={scope} variant="secondary" className="text-[10px] font-mono bg-secondary/50 text-secondary-foreground border-border/50">
                          {scope}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="align-top py-4 text-muted-foreground whitespace-nowrap text-sm">
                    {format(new Date(cred.createdAt), "MMM d, yyyy")}
                  </TableCell>
                  <TableCell className="align-top py-4 text-muted-foreground whitespace-nowrap text-sm">
                    {cred.lastUsedAt ? format(new Date(cred.lastUsedAt), "MMM d, yyyy") : "Never"}
                  </TableCell>
                  <TableCell className="align-top py-4">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-[180px] bg-card border-border shadow-xl">
                        <DropdownMenuItem 
                          disabled={!cred.isActive}
                          onClick={() => setRotateConfirmTarget(cred.id)}
                          className="gap-2 cursor-pointer py-2 focus:bg-accent focus:text-foreground"
                          data-testid={`menu-rotate-${cred.id}`}
                        >
                          <RefreshCw className="h-4 w-4 text-primary" />
                          Rotate Key
                        </DropdownMenuItem>
                        <DropdownMenuItem 
                          disabled={!cred.isActive}
                          onClick={() => setRevokeConfirmTarget(cred.id)}
                          className="gap-2 cursor-pointer py-2 text-destructive focus:text-destructive focus:bg-destructive/10"
                          data-testid={`menu-revoke-${cred.id}`}
                        >
                          <XCircle className="h-4 w-4" />
                          Revoke
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Forms & Dialogs */}
      <CreateCredentialDialog 
        orgId={orgId} 
        open={createDialogOpen} 
        onOpenChange={setCreateDialogOpen} 
        onCreated={handleCreated} 
      />

      {showKeyData && (
        <ShowKeyDialog 
          apiKey={showKeyData.apiKey} 
          name={showKeyData.name}
          open={!!showKeyData} 
          onOpenChange={(open) => {
            if (!open) setShowKeyData(null);
          }} 
        />
      )}

      {/* Rotate Confirm */}
      <AlertDialog open={!!rotateConfirmTarget} onOpenChange={(open) => !open && setRotateConfirmTarget(null)}>
        <AlertDialogContent className="border-border bg-card shadow-xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-xl flex items-center gap-2">
              <RefreshCw className="h-5 w-5 text-primary" />
              Rotate API Key
            </AlertDialogTitle>
            <AlertDialogDescription className="text-base mt-2">
              This will immediately invalidate the current API key and generate a new one. 
              Any active integrations using the old key will stop working until updated.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-4">
            <AlertDialogCancel disabled={rotateMut.isPending} data-testid="button-cancel-rotate">Cancel</AlertDialogCancel>
            <Button 
              onClick={() => {
                if (rotateConfirmTarget) {
                  rotateMut.mutate({ orgId, credentialId: rotateConfirmTarget }, {
                    onSuccess: (data) => {
                      const name = credentialsData?.credentials.find(c => c.id === rotateConfirmTarget)?.name || "Credential";
                      const apiKey = data.apiKey;
                      rotateMut.reset();
                      handleRotated(apiKey, name);
                    },
                    onError: (err) => {
                      toast({ title: "Failed to rotate key", description: err.data?.error || err.message, variant: "destructive" });
                    }
                  });
                }
              }}
              disabled={rotateMut.isPending}
              data-testid="button-confirm-rotate"
            >
              {rotateMut.isPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
              Rotate Key
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Revoke Confirm */}
      <AlertDialog open={!!revokeConfirmTarget} onOpenChange={(open) => !open && setRevokeConfirmTarget(null)}>
        <AlertDialogContent className="border-border bg-card shadow-xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-xl flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Revoke Credential
            </AlertDialogTitle>
            <AlertDialogDescription className="text-base mt-2">
              Are you sure you want to revoke this credential? It will be permanently deactivated and can never be used again. Active integrations will immediately fail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-4">
            <AlertDialogCancel disabled={revokeMut.isPending} data-testid="button-cancel-revoke">Cancel</AlertDialogCancel>
            <Button 
              variant="destructive"
              onClick={() => {
                if (revokeConfirmTarget) {
                  revokeMut.mutate({ orgId, credentialId: revokeConfirmTarget }, {
                    onSuccess: () => handleRevoked(),
                    onError: (err) => {
                      toast({ title: "Failed to revoke credential", description: err.data?.error || err.message, variant: "destructive" });
                    }
                  });
                }
              }}
              disabled={revokeMut.isPending}
              data-testid="button-confirm-revoke"
            >
              {revokeMut.isPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
              Revoke Credential
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}