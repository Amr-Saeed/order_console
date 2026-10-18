import bcrypt from "bcryptjs";
import { config } from "./config";
import { openDb, STATUSES } from "./db";

const TOTAL = Number(process.argv[2] ?? 50_000);

const FIRST = ["Omar","Layla","Youssef","Nour","Hassan","Mariam","Karim","Salma","Ahmed","Dina","Tarek","Hana","Ali","Rana","Mostafa","Farah","Sara","John","Emma","Liam","Olivia","Noah","Ava","Lucas","Mia","Daniel","Chloe","Ethan","Zoe","Adam"];
const LAST = ["Hassan","Ibrahim","Mansour","Saleh","Nasser","Farouk","Khalil","Soliman","Fahmy","Adel","Smith","Johnson","Brown","Taylor","Wilson","Moore","Clark","Lewis","Walker","Hall","Young","King","Wright","Scott","Green","Baker","Hill","Adams","Nelson","Carter"];
const DOMAINS = ["example.com", "mail.test", "shop.test", "demo.org"];
const PRODUCTS = ["Wireless Mouse","USB-C Cable","Desk Lamp","Notebook","Phone Case","Backpack","Water Bottle","Keyboard","Headphones","Monitor Stand","Webcam","Charger"];
// Weighted so "cancelled" is a minority, like real life.
const STATUS_POOL = ["pending","pending","paid","paid","paid","shipped","shipped","delivered","delivered","delivered","delivered","cancelled"] as const;

// Small deterministic PRNG so every seed run looks the same.
let s = 42;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));

const db = openDb(config.dbPath);

const users = db.prepare("INSERT OR IGNORE INTO users (email, password_hash, role) VALUES (?, ?, ?)");
users.run("admin@sarh.test", bcrypt.hashSync("Admin123!", 10), "admin");
users.run("agent@sarh.test", bcrypt.hashSync("Agent123!", 10), "agent");

if ((db.prepare("SELECT COUNT(*) c FROM orders").get() as { c: number }).c > 0) {
  console.log("Orders already seeded — delete server/data/orders.db to start over.");
  process.exit(0);
}

const insOrder = db.prepare(`INSERT INTO orders (customer_name, customer_email, status, total_cents, item_count, created_at)
  VALUES (?, ?, ?, ?, ?, ?)`);
const insItem = db.prepare("INSERT INTO order_items (order_id, name, quantity, unit_cents) VALUES (?, ?, ?, ?)");

const now = Date.now();
const TWO_YEARS = 2 * 365 * 24 * 3600 * 1000;
const t0 = performance.now();

db.transaction(() => { // one transaction = seconds instead of minutes
  for (let i = 0; i < TOTAL; i++) {
    const first = pick(FIRST), last = pick(LAST);
    const items = Array.from({ length: int(1, 5) }, () => ({ name: pick(PRODUCTS), qty: int(1, 4), cents: int(5, 400) * 100 - int(0, 1) * 1 }));
    const total = items.reduce((sum, it) => sum + it.qty * it.cents, 0);
    const id = Number(insOrder.run(
      `${first} ${last}`, `${first}.${last}${int(1, 999)}@${pick(DOMAINS)}`.toLowerCase(),
      pick(STATUS_POOL), total, items.length, now - Math.floor(rnd() * TWO_YEARS)).lastInsertRowid);
    for (const it of items) insItem.run(id, it.name, it.qty, it.cents);
  }
})();

db.exec("INSERT INTO orders_fts(orders_fts) VALUES('optimize')");
console.log(`Seeded ${TOTAL} orders in ${((performance.now() - t0) / 1000).toFixed(1)}s (statuses: ${STATUSES.join(", ")}).`);
console.log("Users: admin@sarh.test / Admin123!   agent@sarh.test / Agent123!");
