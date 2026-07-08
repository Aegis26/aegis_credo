import { Router, type IRouter } from "express";
import healthRouter from "./health";
import practiceRouter from "./practice";
import closeRouter from "./close";

const router: IRouter = Router();

router.use(healthRouter);
router.use(practiceRouter);
router.use(closeRouter);

export default router;
