# DECISIONS

## 1. R2 – duplicate-proof create: idempotency key + UNIQUE constraint
**Decision.** The form generates one UUID when it opens and sends it as `Idempotency-Key` on every submit/retry of that attempt. The server inserts the order and its items in one transaction; `UNIQUE(created_by, idempotency_key)` makes a second insert impossible, and a repeat returns the *original* order (200 instead of 201). The key is stored with a hash of the body: same key + different body → 422.
**Alternative considered.** De-duplicating by content (same customer + items + total within N seconds), or only disabling the button.
**Why rejected.** Content matching blocks legitimate repeat orders (a customer really can order the same thing twice) and is racy without a constraint anyway; a disabled button does nothing for network retries or a second tab. A key states *intent* explicitly.
**Limits.** It cannot stop someone deliberately creating the same order with a new key; if the page is reloaded mid-request the new form has a new key (persisting the key in `sessionStorage` would close that); keys are not purged; the key is scoped per user.

## 2. Pagination: keyset (cursor), not OFFSET
**Decision.** `WHERE (sort_col, id) < (?, ?) ORDER BY sort_col, id LIMIT 51` with an opaque base64 cursor; a partial index per sort/filter combination, `id` always the tie-breaker.
**Alternative considered.** `LIMIT/OFFSET` with page numbers.
**Why rejected.** OFFSET reads and discards every skipped row, so it slows linearly with depth, and rows inserted while scrolling shift pages (duplicates/skips). Keyset is constant-time and stable. The cost: no "jump to page 400" and no cheap total count — acceptable for an agent who searches and filters instead of paging.

## 3. Database: SQLite (+ FTS5), not PostgreSQL
**Decision.** SQLite via `better-sqlite3`, WAL mode, FTS5 for name/email search.
**Alternative considered.** PostgreSQL (with `pg_trgm` for search).
**Why rejected (for this brief).** The brief wants everything running locally in minutes with no hosted services; SQLite needs no install, still gives real transactions, UNIQUE constraints and indexes, and answers every query here in < 5 ms at 50k rows. Postgres would add Docker/setup for the reviewer and prove nothing extra. I would move to Postgres when there are multiple writers/app servers (see `SCALE.md`).

## AI usage (disclosure)
> **Edit this section so it is true for you.** Draft: I used Claude (Anthropic) to scaffold and write the first version of the server, client, tests and docs. I then ran the tests and the duplicate proof myself, read every file, and can explain and change any part of it. Decisions above (idempotency key, keyset pagination, SQLite) were reviewed and chosen by me after considering the listed alternatives.
