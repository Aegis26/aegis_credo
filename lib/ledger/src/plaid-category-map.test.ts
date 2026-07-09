import { describe, it, expect } from "vitest";
import { mapPlaidCategoryToAccountCode } from "./plaid-category-map";

describe("mapPlaidCategoryToAccountCode", () => {
  it("maps meals (FOOD_AND_DRINK) to Meals & Entertainment 5400", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "FOOD_AND_DRINK",
        detailed: "FOOD_AND_DRINK_RESTAURANT",
        name: "McDon's",
        direction: "out",
      }),
    ).toBe("5400");
  });

  it("maps travel (TRAVEL) to Travel 5500", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "TRAVEL",
        detailed: "TRAVEL_FLIGHTS",
        name: "United Airlines",
        direction: "out",
      }),
    ).toBe("5500");
  });

  it("maps rideshare (TRANSPORTATION_TAXIS_AND_RIDE_SHARES) to Travel 5500", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "TRANSPORTATION",
        detailed: "TRANSPORTATION_TAXIS_AND_RIDE_SHARES",
        name: "Uber 063015 SF**POOL**",
        direction: "out",
      }),
    ).toBe("5500");
  });

  it("routes payroll/Gusto to Salaries 5200 by merchant name", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "TRANSFER_IN",
        detailed: "TRANSFER_IN_ACCOUNT_TRANSFER",
        name: "ACH Electronic CreditGUSTO PAY 123456",
        direction: "out",
      }),
    ).toBe("5200");
  });

  it("routes generic PAYROLL names to Salaries 5200", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "GENERAL_SERVICES",
        detailed: null,
        name: "ADP PAYROLL FEES",
        direction: "out",
      }),
    ).toBe("5200");
  });

  it("maps software by vendor name to Software & Subscriptions 5600", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "GENERAL_MERCHANDISE",
        detailed: "GENERAL_MERCHANDISE_ELECTRONICS",
        name: "Adobe Creative Cloud",
        direction: "out",
      }),
    ).toBe("5600");
  });

  it("maps GENERAL_SERVICES to Software & Subscriptions 5600", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "GENERAL_SERVICES",
        detailed: "GENERAL_SERVICES_OTHER_GENERAL_SERVICES",
        name: "SomeSaaS Co",
        direction: "out",
      }),
    ).toBe("5600");
  });

  it("maps bank fees (BANK_FEES) to Bank Fees 5700", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "BANK_FEES",
        detailed: "BANK_FEES_OVERDRAFT_FEES",
        name: "Overdraft Fee",
        direction: "out",
      }),
    ).toBe("5700");
  });

  it("splits RENT_AND_UTILITIES into Rent 5100 vs Utilities 5300", () => {
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "RENT_AND_UTILITIES",
        detailed: "RENT_AND_UTILITIES_RENT",
        name: "Landlord",
        direction: "out",
      }),
    ).toBe("5100");
    expect(
      mapPlaidCategoryToAccountCode({
        primary: "RENT_AND_UTILITIES",
        detailed: "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY",
        name: "Power Co",
        direction: "out",
      }),
    ).toBe("5300");
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
