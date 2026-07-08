import { useState } from "react";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { useGetTaxEstimate, getGetTaxEstimateQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";

export default function Taxes() {
  const { orgId } = useCurrentOrg();
  const [rate, setRate] = useState(0.25);

  const { data: estimate, isLoading } = useGetTaxEstimate(orgId || "", { rate }, {
    query: {
      enabled: !!orgId,
      queryKey: getGetTaxEstimateQueryKey(orgId || "", { rate }),
    },
  });

  if (!orgId) return null;

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <div>
        <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Taxes</h1>
        <p className="text-muted-foreground mt-1">Estimate what you should set aside for tax season.</p>
      </div>

      <Card className="shadow-sm border-border">
        <CardHeader>
          <CardTitle>Tax Set-Aside Estimate</CardTitle>
          <CardDescription>Based on your current net income</CardDescription>
        </CardHeader>
        <CardContent className="space-y-8">
          {isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : estimate ? (
            <>
              <div className="flex items-center justify-between p-6 bg-muted/30 rounded-lg border border-border">
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Net Income</p>
                  <p className="text-2xl font-serif">${estimate.netIncome}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-muted-foreground mb-1">Estimated Tax</p>
                  <p className="text-4xl font-serif text-primary">${estimate.estimatedSetAside}</p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <Label className="text-base font-medium">Set-aside Rate</Label>
                  <span className="font-mono bg-muted px-2 py-1 rounded text-sm">{Math.round(rate * 100)}%</span>
                </div>
                <Slider
                  value={[rate * 100]}
                  min={10}
                  max={50}
                  step={1}
                  onValueChange={(vals) => setRate(vals[0] / 100)}
                  className="py-4"
                />
                <p className="text-sm text-muted-foreground text-center">
                  Adjust the slider to change your estimated tax bracket.
                </p>
              </div>

              <div className="bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-200 p-4 rounded-lg text-sm border border-amber-200 dark:border-amber-900/50">
                <strong>Important:</strong> {estimate.disclaimer}
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
