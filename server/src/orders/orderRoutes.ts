import { Router } from "express";
import type { AuthService } from "../auth/authService";
import { requireAuth, requireRole } from "../auth/authMiddleware";
import type { DB } from "../db";
import { createOrderController } from "./orderController";

export function createOrderRoutes(db: DB, auth: AuthService, debugDelay: boolean) {
  const router = Router();
  const controller = createOrderController(db, debugDelay);
  router.get("/", requireAuth(auth), controller.list);
  router.get("/stats", requireAuth(auth), controller.stats);
  router.post("/", requireAuth(auth), controller.create);
  router.delete("/:id", requireAuth(auth), requireRole("admin"), controller.remove);
  return router;
}
