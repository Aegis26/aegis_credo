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

const onboardingSchema = z.object({
  name: z.string().min(1, "Business name is required").max(200, "Name is too long"),
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
          toast({ title: "Business created", description: "Your chart of accounts is ready." });
          setLocation("/");
        },
        onError: (error) => {
          toast({
            variant: "destructive",
            title: "Setup failed",
            description: error.data?.error || "Could not set up your business.",
          });
        },
      }
    );
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="text-4xl font-serif font-bold text-primary mb-2">Books</h1>
          <p className="text-muted-foreground">Let's set up your business</p>
        </div>

        <Card className="border-border shadow-md">
          <CardHeader>
            <CardTitle className="text-2xl text-center">Business Details</CardTitle>
            <CardDescription className="text-center">
              What do you call your freelance practice? We'll use this to set up your accounts.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <Label>Business Name</Label>
                      <FormControl>
                        <Input placeholder="Jane Doe Design" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit" className="w-full" disabled={createOrg.isPending}>
                  {createOrg.isPending ? "Setting up..." : "Continue"}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
