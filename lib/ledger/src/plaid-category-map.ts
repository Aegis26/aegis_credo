/**
 * Shared mapping from a bank transaction's Plaid personal_finance_category (plus
 * merchant name and cash direction) to a chart-of-accounts CODE. This is the
 * single source of truth used by every face that suggests a category for an
 * imported transaction, so a wrong mapping can't diverge between surfaces.
 *
 * Codes returned here must exist in STARTER_CHART_OF_ACCOUNTS (see seed.ts).
 * Returns null when we can't confidently suggest an account — callers should
 * then leave the category unset rather than guess.
 */

export type CashDirection = "in" | "out";

export interface PlaidCategorySignal {
  /** Plaid personal_finance_category.primary, e.g. "FOOD_AND_DRINK". */
  primary?: string | null;
  /** Plaid personal_finance_category.detailed, e.g. "RENT_AND_UTILITIES_RENT". */
  detailed?: string | null;
  /** Merchant / transaction name, used for provider-specific overrides. */
  name?: string | null;
  /** Direction derived from the signed amount: "out" = expense, "in" = revenue. */
  direction: CashDirection;
}

const norm = (s?: string | null): string => (s ?? "").toUpperCase();

/**
 * Payroll providers, matched on the transaction name. Employer payroll runs are
 * unreliably categorised by Plaid's PFC (often TRANSFER_* or INCOME), so the
 * merchant name is the dependable signal for routing them to Salaries.
 */
const PAYROLL_NAME_HINTS = [
  "GUSTO",
  "PAYROLL",
  "ADP",
  "PAYCHEX",
  "QUICKBOOKS PAYROLL",
  "RIPPLING",
  "JUSTWORKS",
];

/** Common software / SaaS vendors and subscription keywords. */
const SOFTWARE_NAME_HINTS = [
  "ADOBE",
  "GITHUB",
  "FIGMA",
  "NOTION",
  "SLACK",
  "ZOOM",
  "AWS",
  "AMAZON WEB SERVICES",
  "GOOGLE CLOUD",
  "MICROSOFT",
  "DROPBOX",
  "ATLASSIAN",
  "VERCEL",
  "NETLIFY",
  "OPENAI",
  "SUBSCRIPTION",
  "SAAS",
];

/** Payment processors / merchant-services providers. */
const MERCHANT_FEE_NAME_HINTS = [
  "STRIPE",
  "SQUARE",
  "PAYPAL",
  "BRAINTREE",
  "ADYEN",
  "SHOPIFY PAYMENTS",
  "AUTHORIZE.NET",
  "MERCHANT FEE",
  "PROCESSING FEE",
];

/** Advertising / marketing platforms. */
const ADVERTISING_NAME_HINTS = [
  "GOOGLE ADS",
  "GOOGLE ADWORDS",
  "FACEBOOK ADS",
  "META ADS",
  "META PLATFORMS",
  "LINKEDIN ADS",
  "TWITTER ADS",
  "TIKTOK ADS",
  "MAILCHIMP",
  "HUBSPOT",
];

/** Contractor / professional-services firms and keywords. */
const CONTRACTOR_NAME_HINTS = [
  "LAW",
  "LEGAL",
  "ATTORNEY",
  "ACCOUNTING",
  "CPA",
  "CONSULT",
  "CONTRACTOR",
  "FREELANCE",
  "UPWORK",
  "FIVERR",
];

/** Insurance carriers / keywords. */
const INSURANCE_NAME_HINTS = [
  "INSURANCE",
  "GEICO",
  "ALLSTATE",
  "STATE FARM",
  "PROGRESSIVE",
  "HISCOX",
  "NEXT INSURANCE",
];

/** Office-supply retailers / keywords. */
const OFFICE_SUPPLY_NAME_HINTS = [
  "STAPLES",
  "OFFICE DEPOT",
  "OFFICEMAX",
  "OFFICE SUPPLIES",
  "ULINE",
];

/**
 * Suggest a COA account code for an imported bank transaction. Money in maps to
 * revenue; money out maps to the best-fit expense account.
 */
export function mapPlaidCategoryToAccountCode(
  signal: PlaidCategorySignal,
): string | null {
  const primary = norm(signal.primary);
  const detailed = norm(signal.detailed);
  const name = norm(signal.name);

  // Money in → revenue.
  if (signal.direction === "in") {
    return "4000"; // Sales Revenue
  }

  // Money out → expense. Provider-name overrides win over the generic PFC,
  // because Plaid mis-labels employer payroll and many SaaS charges.
  if (PAYROLL_NAME_HINTS.some((h) => name.includes(h))) return "6300"; // Payroll / Wages
  if (MERCHANT_FEE_NAME_HINTS.some((h) => name.includes(h))) return "6050"; // Bank & Merchant Fees
  if (ADVERTISING_NAME_HINTS.some((h) => name.includes(h))) return "6000"; // Advertising & Marketing
  if (INSURANCE_NAME_HINTS.some((h) => name.includes(h))) return "6150"; // Insurance
  if (OFFICE_SUPPLY_NAME_HINTS.some((h) => name.includes(h))) return "6250"; // Office Supplies
  if (CONTRACTOR_NAME_HINTS.some((h) => name.includes(h))) return "6350"; // Professional Fees
  if (SOFTWARE_NAME_HINTS.some((h) => name.includes(h))) return "6500"; // Software & Technology

  switch (primary) {
    case "FOOD_AND_DRINK":
    case "ENTERTAINMENT":
      return "6200"; // Meals & Entertainment
    case "TRANSPORTATION":
    case "TRAVEL":
      return "6550"; // Travel
    case "BANK_FEES":
      return "6050"; // Bank & Merchant Fees
    case "GENERAL_SERVICES":
      // Professional services (legal, accounting, consulting) → Professional
      // Fees; everything else general → Software & Technology.
      if (
        detailed.includes("LEGAL") ||
        detailed.includes("ACCOUNTING") ||
        detailed.includes("CONSULTING")
      ) {
        return "6350"; // Professional Fees
      }
      return "6500"; // Software & Technology (professional services)
    case "RENT_AND_UTILITIES":
      // The primary itself starts with "RENT_", so match the rent-specific
      // detailed suffix, not a bare "RENT" substring.
      return detailed.endsWith("_RENT") ? "6400" : "6600"; // Rent vs Utilities
    default:
      return null;
  }
}
