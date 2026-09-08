import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useLocation } from "wouter";
import { useCompletePasswordReset } from "@workspace/api-client-react";
import { CheckCircle2, KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BRAND_NAME, BrandLogo } from "@/lib/brand";

const resetSchema = z
  .object({
    password: z.string().min(8, "Use at least 8 characters"),
    confirmation: z.string().min(1, "Confirm your new password"),
  })
  .refine((values) => values.password === values.confirmation, {
    message: "Passwords do not match",
    path: ["confirmation"],
  });

type ResetForm = z.infer<typeof resetSchema>;

export default function ResetPassword() {
  const [, setLocation] = useLocation();
  const reset = useCompletePasswordReset();
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const form = useForm<ResetForm>({
    resolver: zodResolver(resetSchema),
    defaultValues: { password: "", confirmation: "" },
  });

  const submit = (values: ResetForm) => {
    if (!token) return;
    reset.mutate({ data: { token, newPassword: values.password } });
  };

  return (
    <main className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-black px-6 py-12">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[#1E90FF]/10 to-[#3CB54A]/10 opacity-40" />
      <div className="pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full bg-[#1E90FF]/20 blur-[110px]" />
      <div className="pointer-events-none absolute -bottom-24 -right-24 h-96 w-96 rounded-full bg-[#3CB54A]/20 blur-[110px]" />

      <div className="relative z-10 w-full max-w-md space-y-6">
        <div className="flex flex-col items-center text-center">
          <BrandLogo className="mb-3 h-24 w-auto" />
          <p className="text-sm font-medium tracking-wide text-[#B8C0C8]">
            {BRAND_NAME}
          </p>
        </div>

        <Card className="border-border bg-card shadow-2xl">
          {reset.isSuccess ? (
            <>
              <CardHeader className="text-center">
                <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-[#3CB54A]" />
                <CardTitle>Password updated</CardTitle>
                <CardDescription>
                  Your reset link has been consumed. Sign in with your new
                  password.
                </CardDescription>
              </CardHeader>
              <CardFooter>
                <Button className="w-full" onClick={() => setLocation("/login")}>
                  Continue to login
                </Button>
              </CardFooter>
            </>
          ) : (
            <>
              <CardHeader>
                <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <KeyRound className="h-5 w-5 text-primary" />
                </div>
                <CardTitle>Set a new password</CardTitle>
                <CardDescription>
                  This secure link works once and expires after 30 minutes.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!token ? (
                  <div
                    className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                    role="alert"
                  >
                    This reset link is incomplete. Ask your administrator for a
                    new link.
                  </div>
                ) : (
                  <Form {...form}>
                    <form
                      className="space-y-5"
                      onSubmit={form.handleSubmit(submit)}
                    >
                      <input
                        aria-hidden="true"
                        autoComplete="username"
                        className="sr-only"
                        name="username"
                        readOnly
                        tabIndex={-1}
                        value=""
                      />
                      <FormField
                        control={form.control}
                        name="password"
                        render={({ field }) => (
                          <FormItem>
                            <Label>New password</Label>
                            <FormControl>
                              <Input
                                autoComplete="new-password"
                                type="password"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="confirmation"
                        render={({ field }) => (
                          <FormItem>
                            <Label>Confirm password</Label>
                            <FormControl>
                              <Input
                                autoComplete="new-password"
                                type="password"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      {reset.isError && (
                        <div
                          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                          role="alert"
                        >
                          This link is invalid, expired, or already used. Ask
                          your administrator for a new reset link.
                        </div>
                      )}
                      <Button
                        className="w-full"
                        disabled={reset.isPending}
                        type="submit"
                      >
                        {reset.isPending
                          ? "Updating password…"
                          : "Update password"}
                      </Button>
                    </form>
                  </Form>
                )}
              </CardContent>
              <CardFooter className="justify-center border-t border-border/50 pt-6">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <ShieldCheck className="h-4 w-4 text-[#3CB54A]" />
                  Your administrator never sees your password
                </div>
              </CardFooter>
            </>
          )}
        </Card>
      </div>
    </main>
  );
}