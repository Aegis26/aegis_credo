import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useSignup } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { BRAND_NAME, BRAND_TAGLINE, BrandLogo } from "@/lib/brand";
import { ShieldCheck } from "lucide-react";

const signupSchema = z.object({
  name: z.string().optional(),
  email: z.string().email("Please enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

type SignupForm = z.infer<typeof signupSchema>;

export default function Signup() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const signup = useSignup();

  const form = useForm<SignupForm>({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      name: "",
      email: "",
      password: "",
    },
  });

  const onSubmit = (data: SignupForm) => {
    signup.mutate(
      { data },
      {
        onSuccess: () => {
          toast({ title: "Account created", description: `Welcome to ${BRAND_NAME}!` });
          setLocation("/");
        },
        onError: (error) => {
          toast({
            variant: "destructive",
            title: "Signup failed",
            description: error.data?.error || "An error occurred during signup.",
          });
        },
      }
    );
  };

  return (
    <div className="min-h-[100dvh] flex bg-[#000000]">
      {/* Left Hero Side - Pure Black per art direction */}
      <div className="hidden lg:flex w-1/2 flex-col justify-center px-20 relative overflow-hidden bg-[#000000]">
        <div className="absolute inset-0 bg-gradient-to-br from-[#1E90FF]/10 to-[#3CB54A]/10 opacity-30 pointer-events-none" />
        <div className="absolute -left-20 -top-20 w-96 h-96 bg-[#1E90FF]/20 rounded-full blur-[100px] pointer-events-none" />
        <div className="absolute -right-20 -bottom-20 w-96 h-96 bg-[#3CB54A]/20 rounded-full blur-[100px] pointer-events-none" />
        
        <div className="relative z-10 flex flex-col items-start max-w-lg">
          <BrandLogo className="h-24 w-auto mb-8 drop-shadow-[0_0_15px_rgba(30,144,255,0.4)]" />
          <h1 className="text-5xl font-serif font-bold text-white mb-4 tracking-tight leading-tight">
            Deploy your secure accounting ledger.
          </h1>
          <p className="text-xl text-[#B8C0C8] font-light mb-12">
            {BRAND_TAGLINE}
          </p>
          <div className="flex items-center gap-3 text-sm text-[#B8C0C8] bg-white/5 border border-white/10 px-4 py-2 rounded-full backdrop-blur-sm">
            <ShieldCheck className="w-4 h-4 text-[#3CB54A]" />
            <span>Enterprise-ready from day one</span>
          </div>
        </div>
      </div>

      {/* Right Signup Side - Base Dark #0A0A0A */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-8 bg-[#0A0A0A]">
        <div className="w-full max-w-md space-y-8">
          <div className="lg:hidden text-center mb-8 flex flex-col items-center">
            <BrandLogo className="h-16 w-auto mb-4" />
            <h1 className="text-3xl font-serif font-bold text-white mb-2">{BRAND_NAME}</h1>
            <p className="text-muted-foreground">{BRAND_TAGLINE}</p>
          </div>

          <Card className="border-border shadow-2xl bg-card">
            <CardHeader className="space-y-1 pb-6">
              <CardTitle className="text-2xl">Provision Account</CardTitle>
              <CardDescription className="text-muted-foreground">
                Set up your credentials to create a new organization
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <Label className="text-foreground">Name (Optional)</Label>
                        <FormControl>
                          <Input className="bg-input/50 border-border focus:border-primary transition-colors" placeholder="Jane Doe" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <Label className="text-foreground">Email</Label>
                        <FormControl>
                          <Input className="bg-input/50 border-border focus:border-primary transition-colors" placeholder="name@example.com" type="email" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <Label className="text-foreground">Password</Label>
                        <FormControl>
                          <Input className="bg-input/50 border-border focus:border-primary transition-colors" placeholder="••••••••" type="password" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" className="w-full bg-primary text-primary-foreground hover:bg-primary/90 mt-2" disabled={signup.isPending}>
                    {signup.isPending ? "Provisioning..." : "Provision Account"}
                  </Button>
                </form>
              </Form>
            </CardContent>
            <CardFooter className="flex justify-center border-t border-border/50 pt-6">
              <p className="text-sm text-muted-foreground">
                Already have an account?{" "}
                <Button variant="link" className="p-0 h-auto font-semibold text-primary" onClick={() => setLocation("/login")}>
                  Sign in
                </Button>
              </p>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}
