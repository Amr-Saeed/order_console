# Orders Console

React + Node + **SQLite** app for searching 50,000+ orders and registering new ones without ever creating duplicates.

```
client/   React 18 + Vite + TypeScript, TanStack Query (data) + TanStack Virtual (virtual list)
server/   Node 22 + Fastify + better-sqlite3 + Zod + JWT (httpOnly cookie)
```

## Run it (about 2 minutes)

Needs **Node 20+** (tested on 22). Nothing else — SQLite is a library inside the Node process, there is no database server to install.

```bash
npm install          # installs root + server + client, and creates server/.env with a random JWT secret
npm run seed         # creates server/data/orders.db and inserts 50,000 orders (~3 s) + 2 users
npm run dev          # API on :3001, web app on http://localhost:5173
```

Sign in at http://localhost:5173 with the seeded users (plain here on purpose; they are bcrypt-hashed in the DB):

| Role  | Email            | Password   | Can do                                   |
|-------|------------------|------------|------------------------------------------|
| agent | agent@sarh.test  | Agent123!  | search, filter, create orders            |
| admin | admin@sarh.test  | Admin123!  | everything above + delete (soft) orders  |

Other commands:

```bash
npm test                    # 18 API tests + 1 UI test (stale responses)
npm run typecheck
npm run prove:duplicates    # R2 proof over real HTTP (server must be running via `npm run dev`)
npm run seed -- 200000      # seed a different number (delete server/data first to re-seed)
```

Reset everything: stop the server, delete `server/data/`, run `npm run seed` again.

## SQLite in 5 minutes (for first-timers)

* SQLite is a database stored in **one file**: `server/data/orders.db` (plus `-wal`/`-shm` helper files while running). `better-sqlite3` is the Node library that reads/writes it. No server, no ports, no passwords.
* It is a real SQL database: tables, indexes, transactions, UNIQUE constraints, full-text search. Those are exactly what this task needs.
* Look inside it with any of: the `sqlite3` CLI (`sqlite3 server/data/orders.db`), the free **DB Browser for SQLite** app, or the **SQLite Viewer** VS Code extension. Useful queries:

```sql
.tables
SELECT status, COUNT(*) FROM orders GROUP BY status;
SELECT * FROM orders ORDER BY id DESC LIMIT 5;
.indexes orders
EXPLAIN QUERY PLAN SELECT id FROM orders WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 50;
```
* Schema + indexes live in `server/src/db.ts`; every query is in `server/src/orders.ts`.

## R1 – fast list that is never stale

* **Server-side keyset (cursor) pagination.** The browser only ever gets 50 rows + a `nextCursor`. Cursor = `(sort value, id)`; the query is `WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 51`, so page 1,000 costs the same as page 1 (`OFFSET` would not).
* **Indexes** (all partial: `WHERE deleted_at IS NULL`, all end in `id` as the tie-breaker):
  `(created_at, id)`, `(total_amount, id)`, `(status, created_at, id)`, `(status, total_amount, id)`. Measured on 50,000 rows: every list query < 5 ms.
* **Search**: SQLite **FTS5** index over name + email, word-prefix matching (`jo sm` finds "John Smith" and `john.smith@…`). Input is turned into a safe quoted FTS query, so users cannot inject FTS syntax.
* **Virtualised rendering**: only the ~20 visible rows exist in the DOM; the next page loads when the "Loading more…" row scrolls into view.
* **Stale responses**: the filters are the TanStack Query *key*, so a response is only ever written under the key it was requested with, and `AbortController` cancels the superseded request. Search is also debounced (250 ms).
* **How to see it yourself**: tick *Simulate slow network* (dev only; the server adds a random 0–2.5 s delay per list request, enabled by `ENABLE_DEBUG_DELAY=1`), then change the status filter three times quickly. Earlier, slower requests finish last — the table still ends on the newest filter, and the "Showing …" line says which one. Automated version: `client/src/OrdersList.test.tsx` (the server answers the first request last and the test asserts the screen shows the last filter and that the old requests were aborted).

## R2 – no duplicate orders

Idempotency key, enforced by the database. Details and limits in `DECISIONS.md`. Proof:

* `npm run prove:duplicates` — fires the same create twice in parallel over real HTTP, then 10 more retries; counts orders in the DB → exactly 1. A new key makes a (legitimate) second order.
* `server/test/api.test.ts` — same thing in-process, plus 20 parallel retries, 422 on same key/different body, and a raw-SQL test that the `UNIQUE` constraint rejects a duplicate by itself.

## Code review (section 3) – what was wrong and what I changed

| # | Problem in the contractor's code | Why it matters | Fix |
|---|---|---|---|
| 1 | `jwt.decode()` instead of `jwt.verify()` | **Signature is never checked** — anyone can forge `{role:"admin"}` | `jwt.verify` with `algorithms: ["HS256"]` (also blocks `alg:none`); tests forge both |
| 2 | Hard-coded secret `"sarh-secret-2026"` in source | Leaks via git; same secret everywhere | Read from `JWT_SECRET` env (≥ 32 chars, server refuses to start otherwise); `.env.example` only |
| 3 | Token accepted from `?token=` query string | Ends up in logs, browser history, `Referer` headers | Only `Authorization: Bearer` or the httpOnly cookie; test proves the URL token is rejected |
| 4 | Passwords stored and compared **in plain text** (`findFirst({email, password})`) | DB leak = every password leaked | bcrypt hashes; constant-time compare, with a dummy hash when the user doesn't exist (no user-enumeration timing) |
| 5 | Token never expires (the comment says `exp`, the code never sets it) | A stolen token works forever | `expiresIn: 8h`, verified on every request |
| 6 | Admin check lives only in the React `AdminOnly` component | Anyone can call `DELETE /orders/:id` with curl | Server-side `requireRole("admin")`; test: agent → 403, admin → 200 |
| 7 | Role trusted from inside the token | Demoted/deleted users keep their power until expiry | User is re-loaded from the DB per request; role comes from the DB |
| 8 | Raw `req.body` passed into the DB query, no validation | Type confusion / injection with ORMs that accept objects; garbage data | Zod schemas on every input; parameterised SQL only |
| 9 | No rate limit on `/login` | Password brute force | 10 attempts / minute / IP (429 afterwards) |
| 10 | Hard `DELETE` with no trace | Irreversible, no audit | Soft delete (`deleted_at`) |
| 11 | Design: auth, routes, DB access and responses in one blob, no error handling, no types | Hard to test and to review | `auth.ts` / `orders.ts` / `app.ts` split, central error handler, TypeScript throughout |
| 12 | Cookie-based auth needs CSRF thought | Cross-site forms could trigger writes | `SameSite=Lax` + required `X-Requested-With` header on every non-GET (browsers can't send it cross-site without a CORS preflight) |

**Where the token is stored and what that protects against.** The JWT is in an `httpOnly; SameSite=Lax` cookie (`Secure` in production), never in `localStorage`. That means injected JavaScript (XSS) cannot *read* and exfiltrate the token, and `SameSite` + the custom header stop cross-site request forgery. It does **not** stop XSS from *acting as the user* while the page is open (it can still call the API from inside the page), so output escaping and a CSP are still required; and the token can still be stolen by someone with access to the machine or by a compromised network without HTTPS.

## Product question: "Delete all cancelled orders"

*I'd ask her:* **Why** — clutter in the list, storage, reporting noise, or privacy? What does "cancelled" cover and are those orders ever needed again (refunds, disputes, accounting/legal retention)? Who may press it, and how often?
*If she can't answer, I'd build instead:* a **Cancelled** filter plus a default view that hides cancelled orders, and an admin-only **"Archive cancelled orders older than N days"** that is a soft delete, shows the exact count before confirming, and can be undone for 30 days.

## What I skipped and why

* **O1 (slow stats API) and O2 (optimistic create):** deliberately skipped; the brief says doing none costs nothing and the time went into R1/R2/review quality.
* **Visual browser run:** the UI was verified by typecheck, a jsdom test and HTTP tests, not by clicking through it in a real browser — please open it once and check the layout (I could not screenshot in my environment). **Replace this note with your own recording/screenshots, which the brief requires.**
* **Substring search** (`%oma%` matching mid-word) is not supported; FTS5 is word-prefix. Chosen for speed; documented trade-off.
* **No refresh tokens / logout-everywhere / password change**; 8 h sessions are enough for this scope.
* **No total row count** in the list (a `COUNT(*)` with filters is the slow part at scale; "N loaded" is shown instead).
* **Idempotency keys are never purged** (they live on the order row; see `DECISIONS.md`).
* **Assumptions:** total is computed on the server from the items (a client-sent total is ignored); new orders start as `pending`; money is stored as integer cents; users in `agent` role can create but not delete.
