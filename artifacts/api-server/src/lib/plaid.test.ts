import { afterEach, describe, expect, it } from "vitest";
import { isPlaidConfigured } from "./plaid";

const original = {
  clientId: process.env.PLAID_CLIENT_ID,
  secret: process.env.PLAID_SECRET,
  environment: process.env.PLAID_ENV,
};

afterEach(() => {
  if (original.clientId === undefined) delete process.env.PLAID_CLIENT_ID;
  else process.env.PLAID_CLIENT_ID = original.clientId;
  if (original.secret === undefined) delete process.env.PLAID_SECRET;
  else process.env.PLAID_SECRET = original.secret;
  if (original.environment === undefined) delete process.env.PLAID_ENV;
  else process.env.PLAID_ENV = original.environment;
});

describe("Plaid configuration", () => {
  it("requires credentials and an exact approved environment", () => {
    process.env.PLAID_CLIENT_ID = "client";
    process.env.PLAID_SECRET = "secret";

    for (const environment of ["sandbox", "development", "production"]) {
      process.env.PLAID_ENV = environment;
      expect(isPlaidConfigured()).toBe(true);
    }

    for (const environment of [undefined, "", "Sandbox", "staging", " sandbox "]) {
      if (environment === undefined) delete process.env.PLAID_ENV;
      else process.env.PLAID_ENV = environment;
      expect(isPlaidConfigured()).toBe(false);
    }
  });

  it("fails closed when either credential is absent", () => {
    process.env.PLAID_ENV = "sandbox";
    delete process.env.PLAID_CLIENT_ID;
    process.env.PLAID_SECRET = "secret";
    expect(isPlaidConfigured()).toBe(false);

    process.env.PLAID_CLIENT_ID = "client";
    delete process.env.PLAID_SECRET;
    expect(isPlaidConfigured()).toBe(false);
  });
});