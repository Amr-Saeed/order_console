/**
 * R2 proof against the REAL running server (real HTTP, real SQLite file).
 * Start the server first (`npm run dev`), then: npm run prove:duplicates
 */
import { randomUUID } from "node:crypto";

const BASE = process.env.API_URL ?? "http://127.0.0.1:3001";
const H = { "content-type": "application/json", "x-requested-with": "orders-console" };

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: H, body: JSON.stringify({ email: "agent@sarh.test", password: "Agent123!" }),
});
if (!login.ok) throw new Error(`Login failed (${login.status}) — did you run the seed?`);
const cookie = login.headers.getSetCookie()[0].split(";")[0];

const marker = "Proof" + randomUUID().replace(/-/g, "").slice(0, 10); // single searchable word
const payload = JSON.stringify({ customerName: marker, customerEmail: "proof@example.com", items: [{ name: "Widget", quantity: 1, unitCents: 999 }] });
const create = (key: string) => fetch(`${BASE}/api/orders`, { method: "POST", headers: { ...H, cookie, "idempotency-key": key }, body: payload });
const countFor = async () => ((await (await fetch(`${BASE}/api/orders?search=${marker}`, { headers: { cookie } })).json()) as { items: unknown[] }).items.length;

console.log(`Customer marker: ${marker}\n`);

const key = randomUUID();
const [a, b] = await Promise.all([create(key), create(key)]);
const [ja, jb] = (await Promise.all([a.json(), b.json()])) as { id: number }[];
console.log(`Request A -> HTTP ${a.status}, order #${ja.id}`);
console.log(`Request B -> HTTP ${b.status}, order #${jb.id}   (same key, fired in parallel)`);
let n = await countFor();
console.log(`Orders in database for this customer: ${n}`);
if (n !== 1 || ja.id !== jb.id) { console.error("FAIL"); process.exit(1); }

// Simulate a client retrying after a timeout, 10 more times at once.
await Promise.all(Array.from({ length: 10 }, () => create(key)));
n = await countFor();
console.log(`After 10 more parallel retries: ${n} order`);
if (n !== 1) { console.error("FAIL"); process.exit(1); }

// A *new* key is a deliberate new order — that is not a duplicate.
await create(randomUUID());
console.log(`With a brand-new key (a real second order): ${await countFor()} orders`);
console.log("\nPASS: exactly one order per Idempotency-Key.");
