import { useState } from "react";
import { 
  useListMyOrgs,
  useCreatePractice,
  useGrantPracticeClient,
  useListPracticeClients,
  getListPracticeClientsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Building, ShieldCheck, ArrowRight } from "lucide-react";

export default function PracticeSetup() {
  const { data: orgsData, isLoading: orgsLoading } = useListMyOrgs();
  const { data: practiceData } = useListPracticeClients();
  const createPractice = useCreatePractice();
  const grantClient = useGrantPracticeClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [practiceName, setPracticeName] = useState("");
  const [selectedOrgs, setSelectedOrgs] = useState<string[]>([]);

  // Assume user has a practice if they have practice clients or the endpoint doesn't fail
  // Wait, if we create a practice, it doesn't return the ID easily without a separate query?
  // The API doesn't seem to have a `useGetPractice` hook in the standard list, only `useListPracticeClients`.
  // If `useCreatePractice` succeeds, it returns the practice object. We can hold that ID in state to do the grants.
  const [createdPracticeId, setCreatedPracticeId] = useState<string | null>(null);

  const toggleOrg = (id: string) => {
    setSelectedOrgs(prev => 
      prev.includes(id) ? prev.filter(o => o !== id) : [...prev, id]
    );
  };

  const handleSetup = async () => {
    if (!practiceName.trim()) {
      toast({ title: "Name required", description: "Please enter a practice name.", variant: "destructive" });
      return;
    }

    try {
      let currentPracticeId = createdPracticeId;
      
      // Step 1: Create practice if we haven't already
      if (!currentPracticeId) {
        const practice = await createPractice.mutateAsync({
          data: { name: practiceName }
        });
        currentPracticeId = practice.id;
        setCreatedPracticeId(practice.id);
      }

      // Step 2: Grant selected clients
      if (selectedOrgs.length > 0 && currentPracticeId) {
        for (const orgId of selectedOrgs) {
          await grantClient.mutateAsync({
            practiceId: currentPracticeId,
            data: { orgId }
          });
        }
        
        toast({ title: "Practice created", description: `Granted access to ${selectedOrgs.length} clients.` });
        queryClient.invalidateQueries({ queryKey: getListPracticeClientsQueryKey() });
        setLocation("/practice");
      } else {
        toast({ title: "Practice created", description: "No clients granted yet." });
        queryClient.invalidateQueries({ queryKey: getListPracticeClientsQueryKey() });
        setLocation("/practice");
      }
    } catch (err) {
      toast({ title: "Error", description: "Failed to setup practice.", variant: "destructive" });
    }
  };

  const orgs = orgsData?.orgs || [];

  return (
    <div className="max-w-2xl mx-auto space-y-8 py-8">
      <div className="text-center space-y-2">
        <div className="mx-auto w-16 h-16 bg-primary/10 flex items-center justify-center rounded-full mb-4">
          <Building className="w-8 h-8 text-primary" />
        </div>
        <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Setup Your Practice</h1>
        <p className="text-muted-foreground text-lg">
          Create your accounting firm to manage multiple client organizations from one dashboard.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Practice Details</CardTitle>
          <CardDescription>What is the name of your accounting firm?</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label htmlFor="practiceName">Firm Name</Label>
            <Input 
              id="practiceName" 
              value={practiceName} 
              onChange={e => setPracticeName(e.target.value)} 
              placeholder="e.g. Acme Accounting Partners" 
              disabled={!!createdPracticeId}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" />
            Grant Client Access
          </CardTitle>
          <CardDescription>
            Select organizations you currently have access to and grant them to your practice. 
            <span className="block mt-1 font-medium text-foreground">
              Note: You must have admin rights on the client organization to grant practice access.
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {orgsLoading ? (
            <div className="flex justify-center py-6"><Spinner /></div>
          ) : orgs.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center bg-muted/30 rounded-md border border-dashed">
              You are not a member of any organizations yet.
            </div>
          ) : (
            <div className="space-y-4">
              {orgs.map(org => (
                <div key={org.id} className="flex items-center space-x-3 p-3 border rounded-md hover:bg-muted/50 transition-colors">
                  <Checkbox 
                    id={`org-${org.id}`} 
                    checked={selectedOrgs.includes(org.id)}
                    onCheckedChange={() => toggleOrg(org.id)}
                  />
                  <Label htmlFor={`org-${org.id}`} className="flex-1 cursor-pointer flex justify-between items-center text-base leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                    <span className="font-medium">{org.name}</span>
                    <span className="text-xs text-muted-foreground font-mono">{org.id.substring(0, 8)}...</span>
                  </Label>
                </div>
              ))}
            </div>
          )}
        </CardContent>
        <CardFooter className="bg-muted/20 border-t pt-6 flex justify-end">
          <Button onClick={handleSetup} disabled={createPractice.isPending || grantClient.isPending} size="lg" className="w-full sm:w-auto">
            {createPractice.isPending || grantClient.isPending ? <Spinner className="mr-2" /> : null}
            Complete Setup <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
