import { createHash } from "node:crypto";
import { z } from "zod";
import type { DB, Status } from "./db";
import { STATUSES } from "./db";

/* ---------- list (keyset pagination) ---------- */

const SORT_COLUMN = { date: "created_at", amount: "total_cents" } as const;

export const listQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(STATUSES).optional(),
  sort: z.enum(["date", "amount"]).default("date"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export class BadCursor extends Error {}

const encodeCursor = (v: number, id: number) => Buffer.from(JSON.stringify([v, id])).toString("base64url");
function decodeCursor(c: string): [number, number] {
  try {
    const parsed = z.tuple([z.number(), z.number()]).parse(JSON.parse(Buffer.from(c, "base64url").toString()));
    return parsed;
  } catch {
    throw new BadCursor("Invalid cursor");
  }
}

/** Turn free text into a safe FTS5 prefix query: `jo sm` -> `"jo"* "sm"*` (AND). */
function toFtsQuery(search: string): string | null {
  const words = search.match(/[\p{L}\p{N}]+/gu);
  return words?.length ? words.map((w) => `"${w}"*`).join(" ") : null;
}

interface Row {
  id: number; customer_name: string; customer_email: string; status: Status;
  total_cents: number; item_count: number; created_at: number;
}

export function listOrders(db: DB, q: ListQuery) {
  const col = SORT_COLUMN[q.sort];
  const asc = q.dir === "asc";
  const where = ["o.deleted_at IS NULL"];
  const params: (string | number)[] = [];

  if (q.status) { where.push("o.status = ?"); params.push(q.status); }
  if (q.search) {
    const fts = toFtsQuery(q.search);
    if (fts) { where.push("o.id IN (SELECT rowid FROM orders_fts WHERE orders_fts MATCH ?)"); params.push(fts); }
  }
  if (q.cursor) {
    const [v, id] = decodeCursor(q.cursor);
    where.push(`(o.${col}, o.id) ${asc ? ">" : "<"} (?, ?)`); // row-value comparison = keyset
    params.push(v, id);
  }

  const sql = `
    SELECT o.id, o.customer_name, o.customer_email, o.status, o.total_cents, o.item_count, o.created_at
    FROM orders o
    WHERE ${where.join(" AND ")}
    ORDER BY o.${col} ${asc ? "ASC" : "DESC"}, o.id ${asc ? "ASC" : "DESC"}
    LIMIT ?`;
  const rows = db.prepare(sql).all(...params, q.limit + 1) as Row[]; // +1 row tells us if there is a next page

  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map(toDto),
    nextCursor: hasMore && last ? encodeCursor(q.sort === "date" ? last.created_at : last.total_cents, last.id) : null,
  };
}

const toDto = (r: Row) => ({
  id: r.id, customerName: r.customer_name, customerEmail: r.customer_email, status: r.status,
  totalCents: r.total_cents, itemCount: r.item_count, createdAt: new Date(r.created_at).toISOString(),
});

/* ---------- create (idempotent) ---------- */

export const createOrderSchema = z.object({
  customerName: z.string().trim().min(1, "Customer name is required").max(100),
  customerEmail: z.string().trim().toLowerCase().email("Enter a valid email").max(200),
  items: z
    .array(z.object({
      name: z.string().trim().min(1, "Item name is required").max(100),
      quantity: z.number().int().min(1).max(1000),
      unitCents: z.number().int().min(1, "Price must be above 0").max(100_000_000),
    }))
    .min(1, "Add at least one item")
    .max(10, "At most 10 items"),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const idempotencyKeySchema = z.string().uuid();

export class IdempotencyConflict extends Error {}

export function createOrder(db: DB, userId: number, key: string, input: CreateOrderInput) {
  // Hash of the validated body: same key + different body = client bug, not a retry.
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const total = input.items.reduce((s, i) => s + i.quantity * i.unitCents, 0); // server computes the total

  const findByKey = db.prepare("SELECT id, request_hash FROM orders WHERE created_by = ? AND idempotency_key = ?");
  const insertOrder = db.prepare(`
    INSERT INTO orders (customer_name, customer_email, status, total_cents, item_count, created_at, created_by, idempotency_key, request_hash)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`);
  const insertItem = db.prepare("INSERT INTO order_items (order_id, name, quantity, unit_cents) VALUES (?, ?, ?, ?)");

  const resolve = (existing: { id: number; request_hash: string }) => {
    if (existing.request_hash !== hash) throw new IdempotencyConflict();
    return { id: existing.id, replayed: true };
  };

  const tx = db.transaction(() => {
    const existing = findByKey.get(userId, key) as { id: number; request_hash: string } | undefined;
    if (existing) return resolve(existing);
    const { lastInsertRowid } = insertOrder.run(
      input.customerName, input.customerEmail, total, input.items.length, Date.now(), userId, key, hash);
    const id = Number(lastInsertRowid);
    for (const it of input.items) insertItem.run(id, it.name, it.quantity, it.unitCents);
    return { id, replayed: false };
  });

  let result: { id: number; replayed: boolean };
  try {
    result = tx.immediate(); // take the write lock up front
  } catch (e) {
    // Another process/connection won the race: the UNIQUE constraint stopped us. Return its order.
    if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      result = resolve(findByKey.get(userId, key) as { id: number; request_hash: string });
    } else throw e;
  }
  return { order: getOrder(db, result.id)!, replayed: result.replayed };
}

export function getOrder(db: DB, id: number) {
  const row = db.prepare(
    `SELECT id, customer_name, customer_email, status, total_cents, item_count, created_at
     FROM orders WHERE id = ? AND deleted_at IS NULL`).get(id) as Row | undefined;
  if (!row) return null;
  const items = db.prepare("SELECT name, quantity, unit_cents AS unitCents FROM order_items WHERE order_id = ?").all(id);
  return { ...toDto(row), items };
}

/** Soft delete: the row stays for audit/refunds, it just disappears from the console. */
export function softDeleteOrder(db: DB, id: number): boolean {
  return db.prepare("UPDATE orders SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(Date.now(), id).changes > 0;
}
