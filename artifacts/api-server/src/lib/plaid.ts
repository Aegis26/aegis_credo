import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
  type Transaction,
} from "plaid";
import { PlaidNotConfiguredError } from "./errors";

/** True when Plaid sandbox credentials are present in the environment. */
export function isPlaidConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

let client: PlaidApi | undefined;

/** Lazily build the sandbox Plaid client; throws 503 when unconfigured. */
function plaid(): PlaidApi {
  if (!isPlaidConfigured()) throw new PlaidNotConfiguredError();
  if (!client) {
    const configuration = new Configuration({
      basePath: PlaidEnvironments.sandbox,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
          "PLAID-SECRET": process.env.PLAID_SECRET,
        },
      },
    });
    client = new PlaidApi(configuration);
  }
  return client;
}

/** Create a Link token to start the connection flow for a user. */
export async function createLinkToken(userId: string): Promise<string> {
  const res = await plaid().linkTokenCreate({
    user: { client_user_id: userId },
    client_name: "Books",
    products: [Products.Transactions],
    country_codes: [CountryCode.Us],
    language: "en",
  });
  return res.data.link_token;
}

export interface ExchangedItem {
  accessToken: string;
  itemId: string;
}

/** Exchange a public token from Link for a durable access token + item id. */
export async function exchangePublicToken(
  publicToken: string,
): Promise<ExchangedItem> {
  const res = await plaid().itemPublicTokenExchange({
    public_token: publicToken,
  });
  return { accessToken: res.data.access_token, itemId: res.data.item_id };
}

/** Best-effort lookup of the connected institution's display name. */
export async function getInstitutionName(
  accessToken: string,
): Promise<string | null> {
  try {
    const item = await plaid().itemGet({ access_token: accessToken });
    const institutionId = item.data.item.institution_id;
    if (!institutionId) return null;
    const inst = await plaid().institutionsGetById({
      institution_id: institutionId,
      country_codes: [CountryCode.Us],
    });
    return inst.data.institution.name;
  } catch {
    return null;
  }
}

export interface SyncedTransactions {
  /** Newly added transactions since the cursor. */
  added: Transaction[];
  /** The cursor to persist for the next incremental sync. */
  cursor: string;
}

/**
 * Pull new transactions incrementally via transactions/sync. Follows the
 * has_more pages until caught up and returns the next cursor to persist.
 */
export async function syncTransactions(
  accessToken: string,
  cursor: string | null,
): Promise<SyncedTransactions> {
  const added: Transaction[] = [];
  let nextCursor = cursor ?? undefined;
  let hasMore = true;

  while (hasMore) {
    const res = await plaid().transactionsSync({
      access_token: accessToken,
      cursor: nextCursor,
    });
    added.push(...res.data.added);
    hasMore = res.data.has_more;
    nextCursor = res.data.next_cursor;
  }

  return { added, cursor: nextCursor ?? "" };
}
