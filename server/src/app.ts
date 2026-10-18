import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { ZodError, z } from "zod";
import { COOKIE_NAME, TOKEN_TTL_SECONDS, makeAuth } from "./auth";
import type { DB } from "./db";
import {
  BadCursor, IdempotencyConflict, createOrder, createOrderSchema, idempotencyKeySchema,
  listOrders, listQuerySchema, softDeleteOrder,
} from "./orders";

export interface AppOptions {
  db: DB;
  jwtSecret: string;
  secureCookies?: boolean;
  debugDelay?: boolean;
  logger?: boolean;
}

const loginSchema = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

export async function buildApp(opts: AppOptions) {
  const { db } = opts;
  const app = Fastify({ logger: opts.logger ?? false });
  const auth = makeAuth(db, opts.jwtSecret);

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // CSRF defence (with SameSite=Lax): browsers cannot add a custom header cross-site without a CORS preflight.
  app.addHook("onRequest", async (req, reply) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers["x-requested-with"] !== "orders-console") {
      return reply.code(403).send({ error: "Missing X-Requested-With header" });
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Validation failed", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    if (err instanceof BadCursor) return reply.code(400).send({ error: err.message });
    if (err instanceof IdempotencyConflict) {
      return reply.code(422).send({ error: "This Idempotency-Key was already used with a different request body" });
    }
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: "Internal server error" });
  });

  app.get("/api/health", async () => ({ ok: true }));

  /* ---- auth ---- */
  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await auth.verifyCredentials(email, password);
    if (!user) return reply.code(401).send({ error: "Wrong email or password" });
    reply.setCookie(COOKIE_NAME, auth.sign(user), {
      httpOnly: true, sameSite: "lax", secure: opts.secureCookies ?? false, path: "/", maxAge: TOKEN_TTL_SECONDS,
    });
    return { user };
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: auth.requireAuth }, async (req) => ({ user: req.user }));

  /* ---- orders (all behind auth) ---- */
  app.get("/api/orders", { preHandler: auth.requireAuth }, async (req) => {
    const query = listQuerySchema.parse(req.query);
    if (opts.debugDelay) {
      const ms = Number((req.query as { delayMs?: string }).delayMs ?? 0);
      if (ms > 0) await new Promise((r) => setTimeout(r, Math.min(ms, 3000)));
    }
    return listOrders(db, query);
  });

  app.post("/api/orders", { preHandler: auth.requireAuth }, async (req, reply) => {
    const key = idempotencyKeySchema.safeParse(req.headers["idempotency-key"]);
    if (!key.success) return reply.code(400).send({ error: "Idempotency-Key header (UUID) is required" });
    const input = createOrderSchema.parse(req.body);
    const { order, replayed } = createOrder(db, req.user!.id, key.data, input);
    reply.header("Idempotent-Replayed", String(replayed));
    return reply.code(replayed ? 200 : 201).send(order);
  });

  // Role check lives on the SERVER. The React AdminOnly component is only cosmetic.
  app.delete("/api/orders/:id", { preHandler: [auth.requireAuth, auth.requireRole("admin")] }, async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    return softDeleteOrder(db, id) ? { ok: true } : reply.code(404).send({ error: "Order not found" });
  });

  return app;
}
