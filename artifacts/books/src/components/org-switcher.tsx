import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateOrg,
  getListMyOrgsQueryKey,
} from "@workspace/api-client-react";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Plus } from "lucide-react";

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD"];

/**
 * Org selector + "Create organization" flow. The special select value opens a
 * dialog; on success the org list query is invalidated (so the new org appears
 * without a refresh) and the user is switched into the new org.
 */
export function OrgSwitcher() {
  const { orgId, setOrg, orgs } = useCurrentOrg();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createOrg = useCreateOrg();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");

  const handleSelect = (value: string) => {
    if (value === "__create__") {
      setCreateOpen(true);
      return;
    }
    setOrg(value);
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    try {
      const org = await createOrg.mutateAsync({
        data: { name: name.trim(), baseCurrency: currency },
      });
      await queryClient.invalidateQueries({
        queryKey: getListMyOrgsQueryKey(),
      });
      setOrg(org.id);
      toast({
        title: "Organization created",
        description: `${org.name} is ready with a starter chart of accounts.`,
      });
      setName("");
      setCurrency("USD");
      setCreateOpen(false);
    } catch {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Could not create the organization.",
      });
    }
  };

  return (
    <>
      <Select value={orgId || ""} onValueChange={handleSelect}>
        <SelectTrigger className="w-full bg-background" data-testid="org-switcher">
          <SelectValue placeholder="Select Organization" />
        </SelectTrigger>
        <SelectContent>
          {orgs.map((org) => (
            <SelectItem key={org.id} value={org.id}>
              {org.name}
            </SelectItem>
          ))}
          <SelectItem value="__create__" data-testid="create-org-option">
            <span className="flex items-center gap-2 text-primary">
              <Plus className="w-4 h-4" />
              Create organization
            </span>
          </SelectItem>
        </SelectContent>
      </Select>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create organization</DialogTitle>
            <DialogDescription>
              The new organization is owned by you and starts with the standard
              chart of accounts.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-org-name">Organization name</Label>
              <Input
                id="new-org-name"
                data-testid="input-org-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme LLC"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                }}
              />
            </div>
            <div className="space-y-2">
              <Label>Base currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger data-testid="select-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!name.trim() || createOrg.isPending}
              data-testid="button-create-org"
            >
              {createOrg.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
