import logoUrl from "@assets/unnamed_1784133052304.png";

export const BRAND_NAME = "Aegis Credo";
export const BRAND_TAGLINE = "Accounting. Clarity. Confidence.";

// Categorical chart palette — distinct, semantically neutral hues tuned for the
// near-black background. Brand blue anchors the set. Green and red are excluded:
// they are reserved as financial signals (money-in / money-out) app-wide.
export const CHART_CATEGORICAL = [
  "#1E90FF", // brand electric blue (anchor)
  "#9B8CE8", // soft violet
  "#45B8B0", // desaturated teal
  "#D4A94C", // muted gold
  "#5FB4D9", // calm cyan
  "#8A97B1", // steel slate
];

export function BrandLogo({ className = "h-8" }: { className?: string }) {
  return (
    <img src={logoUrl} alt={BRAND_NAME} className={className} />
  );
}

export function BrandWordmark({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <BrandLogo className="h-6 w-auto" />
      <span className="font-serif font-bold tracking-tight text-foreground">
        {BRAND_NAME}
      </span>
    </div>
  );
}
