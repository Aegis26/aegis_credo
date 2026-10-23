import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, membershipsTable } from "@workspace/db";
import { ReviewTaxFormsBody, ReviewTaxFormsResponse } from "@workspace/api-zod";
import { getSessionUserId } from "../middlewares/auth";
import { HttpError, sendLedgerError } from "../lib/errors";
import { loadTaxSource, buildTaxReview } from "../lib/tax-forms";
import { generateTaxPdf } from "../lib/tax-forms-pdf";

const router: IRouter = Router();
// Owner-only, session-only. Platform administration is not tenant membership.
async function owner(orgId: string, userId: string) {
  const [row] = await db.select({ id: membershipsTable.id }).from(membershipsTable).where(and(
    eq(membershipsTable.orgId, orgId), eq(membershipsTable.userId, userId),
    eq(membershipsTable.role, "owner"), isNull(membershipsTable.revokedAt),
  )).limit(1);
  if (!row) throw new HttpError(403, "Tax Forms requires active organization owner access.");
}
for (const action of ["review", "pdf"] as const) {
  router.post(`/orgs/:orgId/tax-forms/${action}`, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const userId = getSessionUserId(req);
      const orgId = z.string().uuid().parse(req.params.orgId);
      await owner(orgId, userId);
      const input = ReviewTaxFormsBody.strict().parse(req.body);
      const source = await loadTaxSource(orgId, input.year);
      const review = buildTaxReview(source, input);
      if (action === "review") { res.json(ReviewTaxFormsResponse.parse(review)); return; }
      if (!input.acknowledged || input.sourceDigest !== review.sourceDigest)
        throw new HttpError(409, "Review is incomplete or ledger changed. Refresh and acknowledge the current figures before downloading.");
      if (!input.kind) throw new HttpError(400, "Choose a draft document.");
      const pdf = await generateTaxPdf(review, input);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="credo-${input.kind}-${input.year}-DRAFT.pdf"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(Buffer.from(pdf));
    } catch (err) { sendLedgerError(res, err); }
  });
}
export default router;
