import { getBalanceSheet, getProfitAndLoss } from "./reporting";
import { getLatestCloseSummary } from "./close";
import {
  listClientsForPracticeUser,
  listClientsForPractice,
  listPracticesForUser,
  type ClientRef,
} from "./practice";
import type { Money } from "./money";
import type { CloseStatus } from "@workspace/db";

/**
 * Practice-level dashboard: a single, access-scoped view of status across every
 * client a practice user has been granted. Read-only over the client ledgers;
 * never mutates any book. Clients the user wasn't granted are simply absent.
 */

export interface DashboardClient {
  orgId: string;
  name: string;
  close: {
    /** Latest close period label, or null when none exists yet. */
    period: string | null;
    status: CloseStatus | null;
    tasksDone: number;
    tasksTotal: number;
    /** done / total, 0..1. */
    progress: number;
    /** PBC requests still awaiting a client response or acceptance. */
    openPbc: number;
  };
  financials: {
    netIncome: Money;
    assets: Money;
    liabilities: Money;
    /** True when assets == liabilities + equity (with income). */
    balanced: boolean;
  };
}

export interface PracticeDashboard {
  generatedAt: string;
  clientCount: number;
  clients: DashboardClient[];
}

async function buildClientRow(client: {
  orgId: string;
  name: string;
}): Promise<DashboardClient> {
  const [close, pl, bs] = await Promise.all([
    getLatestCloseSummary(client.orgId),
    getProfitAndLoss(client.orgId),
    getBalanceSheet(client.orgId),
  ]);

  return {
    orgId: client.orgId,
    name: client.name,
    close: {
      period: close?.period.period ?? null,
      status: close?.period.status ?? null,
      tasksDone: close?.tasks.done ?? 0,
      tasksTotal: close?.tasks.total ?? 0,
      progress: close?.tasks.progress ?? 0,
      openPbc: close?.pbc.open ?? 0,
    },
    financials: {
      netIncome: pl.netIncome,
      assets: bs.assets,
      liabilities: bs.liabilities,
      balanced: bs.balances,
    },
  };
}

/**
 * Build the dashboard for a practice user. When `practiceId` is given, the user
 * must be an active member of it and only that practice's granted clients are
 * shown; otherwise every client reachable across the user's active memberships
 * is included. Either way, only explicitly-granted clients appear.
 */
export async function getPracticeDashboard(
  userId: string,
  practiceId?: string,
): Promise<PracticeDashboard> {
  let clients: Array<{ orgId: string; name: string }>;
  if (practiceId) {
    const memberOf = await listPracticesForUser(userId);
    clients = memberOf.includes(practiceId)
      ? await listClientsForPractice(practiceId)
      : [];
  } else {
    clients = (await listClientsForPracticeUser(userId)).map(
      (c: ClientRef) => ({ orgId: c.orgId, name: c.name }),
    );
  }

  const rows = await Promise.all(clients.map(buildClientRow));
  return {
    generatedAt: new Date().toISOString(),
    clientCount: rows.length,
    clients: rows,
  };
}
