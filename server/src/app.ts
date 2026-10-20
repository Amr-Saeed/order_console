import cookieParser from "cookie-parser";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { ZodError } from "zod";
import { makeAuthService } from "./auth/authService";
import { createAuthRoutes } from "./auth/authRoutes";
import type { DB } from "./db";
import { BadCursor, IdempotencyConflict } from "./orders/orderService";
import { createOrderRoutes } from "./orders/orderRoutes";

export interface AppOptions {
  db: DB;
  jwtSecret: string;
  secureCookies?: boolean;
  debugDelay?: boolean;
  logger?: boolean;
}

interface InjectOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}

interface InjectResponse {
  statusCode: number;
  headers: Record<string, string>;
  cookies: { value: string }[];
  json: <T = any>() => T;
}

export type TestableApp = Express & {
  inject: (options: InjectOptions) => Promise<InjectResponse>;
};

export async function buildApp(opts: AppOptions): Promise<TestableApp> {
  const app = express() as TestableApp;
  const auth = makeAuthService(opts.db, opts.jwtSecret);
  const loginLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });

  app.use(express.json());
  app.use(cookieParser());
  app.use((req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers["x-requested-with"] !== "orders-console") {
      return res.status(403).json({ error: "Missing X-Requested-With header" });
    }
    next();
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/auth", createAuthRoutes(auth, opts.secureCookies ?? false, loginLimiter));
  app.use("/api/orders", createOrderRoutes(opts.db, auth, opts.debugDelay ?? false));

  app.use((err: Error & { statusCode?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: "Validation failed",
        issues: err.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    if (err instanceof BadCursor) return res.status(400).json({ error: err.message });
    if (err instanceof IdempotencyConflict) {
      return res.status(422).json({ error: "This Idempotency-Key was already used with a different request body" });
    }
    if (err.statusCode && err.statusCode < 500) return res.status(err.statusCode).json({ error: err.message });
    if (opts.logger) console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  });

  app.inject = async (request) => {
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to determine test server address");
    try {
      const headers = new Headers(request.headers);
      const body = request.payload === undefined ? undefined : JSON.stringify(request.payload);
      if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
      const response = await fetch(`http://127.0.0.1:${address.port}${request.url}`, {
        method: request.method, headers, body,
      });
      const text = await response.text();
      let parsed: unknown = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
      const setCookies = response.headers.getSetCookie();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => { responseHeaders[key] = value; });
      return {
        statusCode: response.status,
        headers: responseHeaders,
        cookies: setCookies.map((value) => ({ value: value.split(";")[0].split("=")[1] ?? "" })),
        json: <T = any>() => parsed as T,
      };
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };

  return app;
}
