import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { DB } from "../db";
import {
  createOrder, createOrderSchema, getOrderStats, idempotencyKeySchema,
  listOrders, listQuerySchema, softDeleteOrder,
} from "./orderService";

export function createOrderController(db: DB, debugDelay: boolean) {
  return {
    list: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const query = listQuerySchema.parse(req.query);
        if (debugDelay) {
          const ms = Number(req.query.delayMs ?? 0);
          if (ms > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 3000)));
        }
        res.json(listOrders(db, query));
      } catch (error) { next(error); }
    },
    stats: async (_req: Request, res: Response) => {
      await new Promise((resolve) => setTimeout(resolve, 3000 + Math.floor(Math.random() * 3001)));
      res.json(getOrderStats(db));
    },
    create: (req: Request, res: Response, next: NextFunction) => {
      try {
        const key = idempotencyKeySchema.safeParse(req.headers["idempotency-key"]);
        if (!key.success) return res.status(400).json({ error: "Idempotency-Key header (UUID) is required" });
        const input = createOrderSchema.parse(req.body);
        const result = createOrder(db, req.user!.id, key.data, input);
        res.setHeader("Idempotent-Replayed", String(result.replayed));
        return res.status(result.replayed ? 200 : 201).json(result.order);
      } catch (error) { next(error); }
    },
    remove: (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
        return softDeleteOrder(db, id)
          ? res.json({ ok: true })
          : res.status(404).json({ error: "Order not found" });
      } catch (error) { next(error); }
    },
  };
}
