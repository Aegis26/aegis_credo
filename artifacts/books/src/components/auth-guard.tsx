import { useEffect } from "react";
import { useLocation } from "wouter";
import { useGetSession, getGetSessionQueryKey } from "@workspace/api-client-react";
import { Spinner } from "@/components/ui/spinner";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { data: session, isLoading, error } = useGetSession({
    query: {
      retry: false,
      queryKey: getGetSessionQueryKey(),
    },
  });

  useEffect(() => {
    if (!isLoading && (error || !session)) {
      if (location !== "/login" && location !== "/signup") {
        setLocation("/login");
      }
    } else if (!isLoading && session) {
      if (location === "/login" || location === "/signup") {
        setLocation("/");
      }
    }
  }, [isLoading, error, session, location, setLocation]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Spinner className="w-8 h-8 text-primary" />
      </div>
    );
  }

  if (!session && location !== "/login" && location !== "/signup") {
    return null;
  }

  return <>{children}</>;
}
