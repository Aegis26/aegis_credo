import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle } from "lucide-react";
import { BRAND_NAME } from "@/lib/brand";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background">
      <Card className="w-full max-w-md mx-4 border-border shadow-2xl bg-card">
        <CardContent className="pt-6">
          <div className="flex mb-4 gap-3 items-center">
            <div className="bg-destructive/20 p-2 rounded-md">
              <AlertTriangle className="h-8 w-8 text-destructive" />
            </div>
            <h1 className="text-2xl font-serif font-bold text-foreground">404 System Error</h1>
          </div>

          <p className="mt-4 text-sm text-muted-foreground font-mono">
            Error: Endpoint unreachable. The requested {BRAND_NAME} resource could not be found on this server.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
