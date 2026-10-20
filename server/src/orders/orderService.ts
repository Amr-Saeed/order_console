import { createHash } from "node:crypto";
import { z } from "zod";
import type { DB, Status } from "../db";
import { STATUSES } from "../db";

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
export class IdempotencyConflict extends Error {}
export const idempotencyKeySchema = z.string().uuid();

const encodeCursor = (value: number, id: number) =>
  Buffer.from(JSON.stringify([value, id])).toString("base64url");

function decodeCursor(cursor: string): [number, number] {
  try {
    return z.tuple([z.number(), z.number()]).parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString()),
    );
  } catch {
    throw new BadCursor("Invalid cursor");
  }
}

function toFtsQuery(search: string): string | null {
  const words = search.match(/[\p{L}\p{N}]+/gu);
  return words?.length ? words.map((word) => `"${word}"*`).join(" ") : null;
}

interface OrderRow {
  id: number; customer_name: string; customer_email: string; status: Status;
  total_cents: number; item_count: number; created_at: number;
}

const toDto = (row: OrderRow) => ({
  id: row.id, customerName: row.customer_name, customerEmail: row.customer_email,
  status: row.status, totalCents: row.total_cents, itemCount: row.item_count,
  createdAt: new Date(row.created_at).toISOString(),
});

export function listOrders(db: DB, query: ListQuery) {
  const column = SORT_COLUMN[query.sort];
  const ascending = query.dir === "asc";
  const where = ["o.deleted_at IS NULL"];
  const params: (string | number)[] = [];

  if (query.status) { where.push("o.status = ?"); params.push(query.status); }
  if (query.search) {
    const fts = toFtsQuery(query.search);
    if (fts) {
      where.push("o.id IN (SELECT rowid FROM orders_fts WHERE orders_fts MATCH ?)");
      params.push(fts);
    }
  }
  if (query.cursor) {
    const [value, id] = decodeCursor(query.cursor);
    where.push(`(o.${column}, o.id) ${ascending ? ">" : "<"} (?, ?)`);
    params.push(value, id);
  }

  const rows = db.prepare(`
    SELECT o.id, o.customer_name, o.customer_email, o.status, o.total_cents, o.item_count, o.created_at
    FROM orders o WHERE ${where.join(" AND ")}
    ORDER BY o.${column} ${ascending ? "ASC" : "DESC"}, o.id ${ascending ? "ASC" : "DESC"}
    LIMIT ?`).all(...params, query.limit + 1) as OrderRow[];
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map(toDto),
    nextCursor: hasMore && last
      ? encodeCursor(query.sort === "date" ? last.created_at : last.total_cents, last.id)
      : null,
  };
}

export const createOrderSchema = z.object({
  customerName: z.string().trim().min(1, "Customer name is required").max(100),
  customerEmail: z.string().trim().toLowerCase().email("Enter a valid email").max(200),
  items: z.array(z.object({
    name: z.string().trim().min(1, "Item name is required").max(100),
    quantity: z.number().int().min(1).max(1000),
    unitCents: z.number().int().min(1, "Price must be above 0").max(100_000_000),
  })).min(1, "Add at least one item").max(10, "At most 10 items"),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export function getOrder(db: DB, id: number) {
  const row = db.prepare(`SELECT id, customer_name, customer_email, status, total_cents, item_count, created_at
    FROM orders WHERE id = ? AND deleted_at IS NULL`).get(id) as OrderRow | undefined;
  if (!row) return null;
  const items = db.prepare("SELECT name, quantity, unit_cents AS unitCents FROM order_items WHERE order_id = ?").all(id);
  return { ...toDto(row), items };
}

export function createOrder(db: DB, userId: number, key: string, input: CreateOrderInput) {
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const total = input.items.reduce((sum, item) => sum + item.quantity * item.unitCents, 0);
  const findByKey = db.prepare("SELECT id, request_hash FROM orders WHERE created_by = ? AND idempotency_key = ?");
  const insertOrder = db.prepare(`INSERT INTO orders
    (customer_name, customer_email, status, total_cents, item_count, created_at, created_by, idempotency_key, request_hash)
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
    for (const item of input.items) insertItem.run(id, item.name, item.quantity, item.unitCents);
    return { id, replayed: false };
  });
  let result: { id: number; replayed: boolean };
  try {
    result = tx.immediate();
  } catch (error) {
    if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      result = resolve(findByKey.get(userId, key) as { id: number; request_hash: string });
    } else throw error;
  }
  return { order: getOrder(db, result.id)!, replayed: result.replayed };
}

export function softDeleteOrder(db: DB, id: number): boolean {
  return db.prepare("UPDATE orders SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
    .run(Date.now(), id).changes > 0;
}

export function getOrderStats(db: DB) {
  const counts = db.prepare("SELECT status, COUNT(*) AS count FROM orders WHERE deleted_at IS NULL GROUP BY status")
    .all() as { status: Status; count: number }[];
  const byStatus = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<Status, number>;
  for (const row of counts) byStatus[row.status] = row.count;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const revenue = db.prepare("SELECT COALESCE(SUM(total_cents), 0) AS cents FROM orders WHERE deleted_at IS NULL AND created_at >= ?")
    .get(startOfToday.getTime()) as { cents: number };
  return { byStatus, revenueTodayCents: revenue.cents };
}
