import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { openDb } from "../src/db";

const SECRET = "test-secret-test-secret-test-secret-123";
const H = { "x-requested-with": "orders-console" };
const body = (name = "Test Customer") => ({
  customerName: name, customerEmail: "t@example.com", items: [{ name: "Widget", quantity: 2, unitCents: 1500 }],
});

let app: Awaited<ReturnType<typeof buildApp>>;
let db: ReturnType<typeof openDb>;
let agentCookie: string, adminCookie: string;

async function login(email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", headers: H, payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return `token=${res.cookies[0].value}`;
}

beforeAll(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "orders-")), "test.db")); // real file DB, not in-memory
  const ins = db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)");
  ins.run("admin@t.test", bcrypt.hashSync("pw-admin", 4), "admin");
  ins.run("agent@t.test", bcrypt.hashSync("pw-agent", 4), "agent");
  app = await buildApp({ db, jwtSecret: SECRET });
  adminCookie = await login("admin@t.test", "pw-admin");
  agentCookie = await login("agent@t.test", "pw-agent");
});

const post = (key: string | undefined, payload: unknown, cookie = agentCookie) =>
  app.inject({ method: "POST", url: "/api/orders", payload: payload as object,
    headers: { ...H, cookie, ...(key ? { "idempotency-key": key } : {}) } });

describe("R2 – duplicate-proof create", () => {
  it("two parallel requests with the same key create exactly one order", async () => {
    const key = randomUUID();
    const name = "ParallelOne";
    const [a, b] = await Promise.all([post(key, body(name)), post(key, body(name))]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().id).toBe(b.json().id);
    const { c } = db.prepare("SELECT COUNT(*) c FROM orders WHERE idempotency_key = ?").get(key) as { c: number };
    expect(c).toBe(1);
  });

  it("20 parallel retries still create exactly one order", async () => {
    const key = randomUUID();
    const res = await Promise.all(Array.from({ length: 20 }, () => post(key, body("Burst"))));
    expect(new Set(res.map((r) => r.json().id)).size).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM orders WHERE idempotency_key = ?").get(key) as { c: number }).c).toBe(1);
  });

  it("the UNIQUE constraint itself blocks a duplicate, even if app code were bypassed", () => {
    const ins = () => db.prepare(`INSERT INTO orders (customer_name, customer_email, status, total_cents, item_count, created_at, created_by, idempotency_key)
      VALUES ('x','x@x.com','pending',1,1,1,1,'raw-key')`).run();
    ins();
    expect(ins).toThrow(/UNIQUE/);
  });

  it("same key with a different body is rejected (422)", async () => {
    const key = randomUUID();
    expect((await post(key, body("A"))).statusCode).toBe(201);
    expect((await post(key, body("B"))).statusCode).toBe(422);
  });

  it("requires an Idempotency-Key and validates the body on the server", async () => {
    expect((await post(undefined, body())).statusCode).toBe(400);
    const bad = await post(randomUUID(), { customerName: "", customerEmail: "nope", items: [] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues.length).toBeGreaterThan(0);
  });

  it("computes the total on the server from the items", async () => {
    const res = await post(randomUUID(), { ...body(), totalCents: 1 });
    expect(res.json().totalCents).toBe(3000);
  });
});

describe("Code-review fixes (auth)", () => {
  it("rejects unauthenticated requests", async () => {
    expect((await app.inject({ method: "GET", url: "/api/orders" })).statusCode).toBe(401);
  });
  it("rejects a forged token (wrong secret) claiming admin — jwt.decode used to accept this", async () => {
    const forged = jwt.sign({ role: "admin" }, "sarh-secret-2026", { subject: "2" });
    const res = await app.inject({ method: "DELETE", url: "/api/orders/1", headers: { ...H, cookie: `token=${forged}` } });
    expect(res.statusCode).toBe(401);
  });
  it("rejects an unsigned (alg:none) token", async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "1", role: "admin" })}.`;
    expect((await app.inject({ method: "GET", url: "/api/orders", headers: { cookie: `token=${none}` } })).statusCode).toBe(401);
  });
  it("rejects an expired token", async () => {
    const old = jwt.sign({ role: "admin" }, SECRET, { subject: "1", expiresIn: -10 });
    expect((await app.inject({ method: "GET", url: "/api/orders", headers: { cookie: `token=${old}` } })).statusCode).toBe(401);
  });
  it("does not accept the token from the query string", async () => {
    const token = agentCookie.replace("token=", "");
    expect((await app.inject({ method: "GET", url: `/api/orders?token=${token}` })).statusCode).toBe(401);
  });
  it("DELETE is admin-only on the server: agent 403, admin 200 (soft delete)", async () => {
    const created = (await post(randomUUID(), body("ToDelete"))).json();
    const asAgent = await app.inject({ method: "DELETE", url: `/api/orders/${created.id}`, headers: { ...H, cookie: agentCookie } });
    expect(asAgent.statusCode).toBe(403);
    const asAdmin = await app.inject({ method: "DELETE", url: `/api/orders/${created.id}`, headers: { ...H, cookie: adminCookie } });
    expect(asAdmin.statusCode).toBe(200);
    expect((db.prepare("SELECT deleted_at FROM orders WHERE id = ?").get(created.id) as { deleted_at: number }).deleted_at).toBeTruthy();
  });
  it("blocks state-changing requests without the CSRF header", async () => {
    const res = await app.inject({ method: "POST", url: "/api/orders", headers: { cookie: agentCookie, "idempotency-key": randomUUID() }, payload: body() });
    expect(res.statusCode).toBe(403);
  });
  it("login: wrong password -> 401 with a generic message; password is stored hashed", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", headers: H, payload: { email: "admin@t.test", password: "nope" } });
    expect(res.statusCode).toBe(401);
    expect((db.prepare("SELECT password_hash h FROM users WHERE email='admin@t.test'").get() as { h: string }).h).toMatch(/^\$2[aby]\$/);
  });
  it("session cookie is httpOnly + SameSite=Lax", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", headers: H, payload: { email: "agent@t.test", password: "pw-agent" } });
    expect(res.headers["set-cookie"]).toMatch(/HttpOnly/i);
    expect(res.headers["set-cookie"]).toMatch(/SameSite=Lax/i);
  });
});

describe("R1 – keyset pagination", () => {
  it("walks every row exactly once, in order, for both sorts and directions", async () => {
    const ins = db.prepare("INSERT INTO orders (customer_name, customer_email, status, total_cents, item_count, created_at) VALUES (?,?,?,?,1,?)");
    db.transaction(() => { for (let i = 0; i < 230; i++) ins.run(`Pager${i}`, `p${i}@x.com`, "paid", (i % 7) * 100, 1_700_000_000_000 + (i % 5) * 1000); })();
    for (const sort of ["date", "amount"] as const) for (const dir of ["asc", "desc"] as const) {
      const seen: { id: number; v: number }[] = [];
      let cursor: string | null = null;
      do {
        const url: string = `/api/orders?search=pager&sort=${sort}&dir=${dir}&limit=40${cursor ? `&cursor=${cursor}` : ""}`;
        const res = await app.inject({ method: "GET", url, headers: { cookie: agentCookie } });
        const page: { items: { id: number; createdAt: string; totalCents: number }[]; nextCursor: string | null } = res.json();
        for (const o of page.items) seen.push({ id: o.id, v: sort === "date" ? Date.parse(o.createdAt) : o.totalCents });
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen.length).toBe(230);
      expect(new Set(seen.map((s) => s.id)).size).toBe(230);
      const vals = seen.map((s) => s.v);
      expect(vals).toEqual([...vals].sort((a, b) => (dir === "asc" ? a - b : b - a)));
    }
  });
  it("filters by status and searches by word prefix on name or email", async () => {
    db.prepare("INSERT INTO orders (customer_name, customer_email, status, total_cents, item_count, created_at) VALUES ('Zebulon Quux','zq@findme.test','cancelled',5,1,1)").run();
    const r = (await app.inject({ method: "GET", url: "/api/orders?search=zebu&status=cancelled", headers: { cookie: agentCookie } })).json();
    expect(r.items.map((o: { customerName: string }) => o.customerName)).toEqual(["Zebulon Quux"]);
    const byEmail = (await app.inject({ method: "GET", url: "/api/orders?search=findme", headers: { cookie: agentCookie } })).json();
    expect(byEmail.items).toHaveLength(1);
  });
  it("rejects a garbage cursor with 400", async () => {
    expect((await app.inject({ method: "GET", url: "/api/orders?cursor=garbage", headers: { cookie: agentCookie } })).statusCode).toBe(400);
  });
});
