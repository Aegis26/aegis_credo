import logoUrl from "@assets/unnamed_1784133052304.png";

export const BRAND_NAME = "Aegis Credo";
export const BRAND_TAGLINE = "Accounting. Clarity. Confidence.";

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
