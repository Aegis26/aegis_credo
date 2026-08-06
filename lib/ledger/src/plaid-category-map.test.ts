import { describe, it, expect } from "vitest";
import { mapPlaidCategoryToAccountCode } from "./plaid-category-map";

describe("mapPlaidCategoryToAccountCode", () => {
  it("maps meals (FOOD_AND_DRINK) to Meals & Entertainment 6200", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "FOOD_AND_DRINK",
        detailed: "FOOD_AND_DRINK_RESTAURANT",
        name: "McDon's",
        direction: "out",
      }),
    ).toBe("6200");
  });

  it("maps travel (TRAVEL) to Travel 5500", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "TRAVEL",
        detailed: "TRAVEL_FLIGHTS",
        name: "United Airlines",
        direction: "out",
      }),
    ).toBe("6550");
  });

  it("maps rideshare (TRANSPORTATION_TAXIS_AND_RIDE_SHARES) to Travel 5500", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "TRANSPORTATION",
        detailed: "TRANSPORTATION_TAXIS_AND_RIDE_SHARES",
        name: "Uber 063015 SF**POOL**",
        direction: "out",
      }),
    ).toBe("6550");
  });

  it("routes payroll/Gusto to Salaries 5200 by merchant name", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "TRANSFER_IN",
        detailed: "TRANSFER_IN_ACCOUNT_TRANSFER",
        name: "ACH Electronic CreditGUSTO PAY 123456",
        direction: "out",
      }),
    ).toBe("6300");
  });

  it("routes generic PAYROLL names to Salaries 5200", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "GENERAL_SERVICES",
        detailed: null,
        name: "ADP PAYROLL FEES",
        direction: "out",
      }),
    ).toBe("6300");
  });

  it("maps software by vendor name to Software & Subscriptions 5600", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "GENERAL_MERCHANDISE",
        detailed: "GENERAL_MERCHANDISE_ELECTRONICS",
        name: "Adobe Creative Cloud",
        direction: "out",
      }),
    ).toBe("6500");
  });

  it("maps GENERAL_SERVICES to Software & Subscriptions 5600", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "GENERAL_SERVICES",
        detailed: "GENERAL_SERVICES_OTHER_GENERAL_SERVICES",
        name: "SomeSaaS Co",
        direction: "out",
      }),
    ).toBe("6500");
  });

  it("maps bank fees (BANK_FEES) to Bank Fees 5700", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "BANK_FEES",
        detailed: "BANK_FEES_OVERDRAFT_FEES",
        name: "Overdraft Fee",
        direction: "out",
      }),
    ).toBe("6050");
  });

  it("splits RENT_AND_UTILITIES into Rent 5100 vs Utilities 5300", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "RENT_AND_UTILITIES",
        detailed: "RENT_AND_UTILITIES_RENT",
        name: "Landlord",
        direction: "out",
      }),
    ).toBe("6400");
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "RENT_AND_UTILITIES",
        detailed: "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY",
        name: "Power Co",
        direction: "out",
      }),
    ).toBe("6600");
  });

  it("routes payment processors to Bank & Merchant Fees 6050", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "GENERAL_SERVICES",
        detailed: "GENERAL_SERVICES_OTHER_GENERAL_SERVICES",
        name: "STRIPE PROCESSING FEE",
        direction: "out",
      }),
    ).toBe("6050");
  });

  it("routes advertising platforms to Advertising & Marketing 6000", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "GENERAL_SERVICES",
        detailed: null,
        name: "GOOGLE ADS 8829",
        direction: "out",
      }),
    ).toBe("6000");
  });

  it("routes insurance carriers to Insurance 6000", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "GENERAL_SERVICES",
        detailed: null,
        name: "HISCOX INSURANCE PREMIUM",
        direction: "out",
      }),
    ).toBe("6150");
  });

  it("routes office-supply retailers to Office Supplies 5900", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "GENERAL_MERCHANDISE",
        detailed: "GENERAL_MERCHANDISE_OFFICE_SUPPLIES",
        name: "STAPLES STORE #123",
        direction: "out",
      }),
    ).toBe("6250");
  });

  it("routes contractor / professional-services names to Contractor Fees 5800", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "GENERAL_MERCHANDISE",
        detailed: null,
        name: "Upwork Freelance Payment",
        direction: "out",
      }),
    ).toBe("6350");
  });

  it("routes legal/accounting GENERAL_SERVICES detailed to Contractor Fees 5800", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "GENERAL_SERVICES",
        detailed: "GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING",
        name: "Firm & Co",
        direction: "out",
      }),
    ).toBe("6350");
  });

  it("maps any money-in to revenue 4000", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "INCOME",
        detailed: "INCOME_WAGES",
        name: "INTRST PYMNT",
        direction: "in",
      }),
    ).toBe("4000");
  });

  it("returns null for an unrecognised money-out category", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "MEDICAL",
        detailed: "MEDICAL_PRIMARY_CARE",
        name: "Some Clinic",
        direction: "out",
      }),
    ).toBeNull();
  });
});
