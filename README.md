# Orders Console

React + TypeScript frontend and Express + TypeScript backend for searching and creating orders safely. SQLite is the real database. The app is seeded with 50,000 orders and protects order creation with a server-side idempotency guarantee.

## Setup

Requirements: Node.js 20+.

```bash
npm install
npm run seed
npm run dev
```

Open `http://localhost:5173`.

The API runs on `http://127.0.0.1:3001`. `npm install` installs the root, client, and server dependencies and creates `server/.env` with a generated JWT secret.

Seeded development users:

| Role  | Email             | Password    |
| ----- | ----------------- | ----------- |
| Agent | `agent@sarh.test` | `Agent123!` |
| Admin | `admin@sarh.test` | `Admin123!` |

Useful commands:

```bash
npm test
npm run typecheck
npm run prove:duplicates
npm run seed -- 200000
```

`npm run prove:duplicates` expects the API to be running. To reset the database, stop the server, delete `server/data/`, and run `npm run seed` again.

## R1: large list that stays fast and correct

- Orders are filtered and sorted on the server by customer name/email, status, date, and amount.
- The server returns only 50 rows at a time using keyset/cursor pagination; it never sends all 50,000 rows to the browser.
- The frontend uses virtualized rendering, so only visible rows are placed in the DOM.
- SQLite indexes support live-row date and amount sorting and status-plus-sort queries. The schema and indexes are in [`server/src/db.ts`](server/src/db.ts).
- SQLite FTS5 searches customer name and email with safe word-prefix tokens. For example, `Joh` matches `John`; a middle fragment such as `ohn` does not.
- Search is debounced by 250ms.
- TanStack Query includes all filters in the query key and passes an `AbortSignal` to `fetch`. Superseded requests are cancelled and old responses cannot replace the active filter result.
- The rapid-filter test is in [`client/src/OrdersList.test.tsx`](client/src/OrdersList.test.tsx).

## R2: create order without duplicates

- The form validates customer details and line items on the client; the server validates again with Zod.
- The server calculates the total from item quantities and prices instead of trusting a client total.
- Each form attempt creates one UUID and sends it as `Idempotency-Key` on every retry.
- The database has `UNIQUE (created_by, idempotency_key)`.
- Order and item inserts run in one transaction. A first request returns `201`; a retry returns the original order with `200`.
- Reusing a key with a different body returns `422`.
- [`server/scripts/prove-duplicates.ts`](server/scripts/prove-duplicates.ts) sends the same request in parallel and verifies that exactly one order exists. The API tests also cover 20 parallel retries.

## Code review: authentication problems and fixes

| Problem in the contractor code            | Fix                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Hardcoded JWT secret                      | Require `JWT_SECRET` from the environment and reject secrets shorter than 32 characters.            |
| `jwt.decode()` does not verify signatures | Use `jwt.verify()` with the HS256 algorithm allow-list and expiry validation.                       |
| Token accepted through `?token=`          | Accept only the HttpOnly cookie or an `Authorization: Bearer` header.                               |
| Passwords compared as plaintext           | Store bcrypt password hashes and compare with `bcrypt.compare`; use a dummy hash for unknown users. |
| No token expiration                       | Sign tokens with an 8-hour expiry and verify expiry on every request.                               |
| Admin check exists only in React          | Enforce `admin` role in the server delete route.                                                    |
| Role trusted from the token               | Load the current user and role from the database for every authenticated request.                   |
| No request validation                     | Validate login, list, create, cursor, and delete inputs with Zod; use parameterized SQL.            |
| Hard delete has no audit/recovery path    | Use a `deleted_at` soft delete.                                                                     |
| No login brute-force protection           | Rate-limit login attempts to 10 per minute.                                                         |
| Cookie writes need CSRF protection        | Use `SameSite=Lax` and require the custom `X-Requested-With` header on state-changing requests.     |

The backend uses Express in [`server/src/app.ts`](server/src/app.ts), authentication is split between [`server/src/auth/authService.ts`](server/src/auth/authService.ts) and [`server/src/auth/authMiddleware.ts`](server/src/auth/authMiddleware.ts), and order logic is split between [`server/src/orders/orderService.ts`](server/src/orders/orderService.ts), [`server/src/orders/orderController.ts`](server/src/orders/orderController.ts), and [`server/src/orders/orderRoutes.ts`](server/src/orders/orderRoutes.ts).

### Token storage

The JWT is stored in an HttpOnly, SameSite=Lax cookie and is Secure in production. HttpOnly prevents injected JavaScript from reading and exfiltrating the token, but it does not stop XSS from acting as the user while the page is open. SameSite plus the required custom header reduce CSRF risk; they do not replace output escaping, CSP, and HTTPS.

## Optional O1: slow stats API

Implemented:

- `GET /api/orders/stats` returns totals by status and revenue today.
- The endpoint is authenticated and deliberately waits 3–6 seconds.
- [`client/src/features/orders/components/StatsPanel.tsx`](client/src/features/orders/components/StatsPanel.tsx) loads it independently, so the list never waits for statistics.
- The request is cancelled when the component unmounts.
- The UI shows loading and error states and provides one retry action.

O2 optimistic create was skipped. It was optional, and the database-backed idempotency implementation was prioritized instead.

## Product question: “Delete all cancelled orders”

1. Why is the goal: less clutter, storage reduction, reporting, or privacy?
2. What does “cancelled” include, and are cancelled orders needed for refunds, disputes, accounting, or legal retention?
3. Who can perform it, how often, and should it require approval or an audit record?
4. If those answers are unavailable, I would not build irreversible deletion.
5. I would propose an admin-only, previewable soft archive for cancelled orders older than a chosen age, with recovery.

## What was skipped

- O2 optimistic create: skipped because it was optional and would add state/rollback complexity without improving the mandatory duplicate guarantee.
- True arbitrary substring search: FTS5 word-prefix search was chosen for predictable indexed search; the `ohn` limitation is documented above.
- Total row count/page count: omitted because the console uses cursor scrolling and a filtered count can be expensive at larger scale.
- Refresh tokens, password changes, and logout-everywhere: outside this small local assessment.
# order_console
