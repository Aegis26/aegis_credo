import { and, eq } from "drizzle-orm";
import {
  db,
  dimensionsTable,
  auditLogTable,
  type Dimension,
  type DimensionType,
} from "@workspace/db";
import { serializeForAudit } from "./audit";

/**
 * Create (or return the existing) reporting dimension for an org. Dimensions are
 * the values used to tag journal lines — e.g. a "West" location or a "Sales"
 * department. Idempotent per (org, type, name). Audit-logged.
 */
export async function createDimension(
  orgId: string,
  type: DimensionType,
  name: string,
  options: { actor?: string } = {},
): Promise<Dimension> {
  const actor = options.actor ?? "system";
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(dimensionsTable)
      .where(
        and(
          eq(dimensionsTable.orgId, orgId),
          eq(dimensionsTable.type, type),
          eq(dimensionsTable.name, name),
        ),
      )
      .limit(1);
    if (existing) return existing;

    const [dimension] = await tx
      .insert(dimensionsTable)
      .values({ orgId, type, name })
      .returning();

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: "dimension.create",
      entity: "dimension",
      entityId: dimension.id,
      before: null,
      after: serializeForAudit(dimension),
    });

    return dimension;
  });
}

/** List an org's dimensions, optionally filtered to one type. */
export async function listDimensions(
  orgId: string,
  type?: DimensionType,
): Promise<Dimension[]> {
  const conds = [eq(dimensionsTable.orgId, orgId)];
  if (type) conds.push(eq(dimensionsTable.type, type));
  return db
    .select()
    .from(dimensionsTable)
    .where(and(...conds))
    .orderBy(dimensionsTable.type, dimensionsTable.name);
}
