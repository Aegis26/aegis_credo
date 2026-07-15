import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useCreateOrg, useListMyOrgs, getListMyOrgsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { BRAND_NAME, BRAND_TAGLINE, BrandLogo } from "@/lib/brand";

const onboardingSchema = z.object({
  name: z.string().min(1, "Organization name is required").max(200, "Name is too long"),
});

type OnboardingForm = z.infer<typeof onboardingSchema>;

export default function Onboarding() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const createOrg = useCreateOrg();
  const queryClient = useQueryClient();
  const { setOrg } = useCurrentOrg();

  const form = useForm<OnboardingForm>({
    resolver: zodResolver(onboardingSchema),
    defaultValues: {
      name: "",
    },
  });

  const onSubmit = (data: OnboardingForm) => {
    createOrg.mutate(
      { data },
      {
        onSuccess: (org) => {
          queryClient.invalidateQueries({ queryKey: getListMyOrgsQueryKey() });
          setOrg(org.id);
          toast({ title: "Ledger provisioned", description: "Your secure command center is ready." });
          setLocation("/");
        },
        onError: (error) => {
          toast({
            variant: "destructive",
            title: "Setup failed",
            description: error.data?.error || "Could not provision the organization ledger.",
          });
        },
      }
    );
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background p-4 relative overflow-hidden">
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-[#1E90FF]/5 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-[#3CB54A]/5 rounded-full blur-[120px] pointer-events-none" />
      
      <div className="w-full max-w-md space-y-8 relative z-10">
        <div className="text-center flex flex-col items-center">
          <BrandLogo className="h-16 w-auto mb-4" />
          <h1 className="text-4xl font-serif font-bold text-foreground mb-2">{BRAND_NAME}</h1>
          <p className="text-muted-foreground">{BRAND_TAGLINE}</p>
        </div>

        <Card className="border-border shadow-2xl bg-card">
          <CardHeader className="border-b border-border/50 pb-6">
            <CardTitle className="text-2xl text-center">Provision Organization</CardTitle>
            <CardDescription className="text-center mt-2">
              Establish your primary accounting ledger to begin securing your financial data.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <Label className="text-foreground">Organization Name</Label>
                      <FormControl>
                        <Input placeholder="Acme Cyber Defense" className="bg-input/50 border-border focus:border-primary transition-colors" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit" className="w-full bg-primary text-primary-foreground hover:bg-primary/90 mt-2" disabled={createOrg.isPending}>
                  {createOrg.isPending ? "Provisioning Ledger..." : "Initialize Command Center"}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
