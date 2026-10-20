# DECISIONS

## 1. R2 – duplicate-proof create: idempotency key + UNIQUE constraint

**Decision.** The form generates one UUID when it opens and sends it as `Idempotency-Key` on every submit/retry of that attempt. The server inserts the order and its items in one transaction; `UNIQUE(created_by, idempotency_key)` makes a second insert impossible, and a repeat returns the _original_ order (200 instead of 201). The key is stored with a hash of the body: same key + different body → 422.
**Alternative considered.** De-duplicating by content (same customer + items + total within N seconds), or only disabling the button.
**Why rejected.** Content matching blocks legitimate repeat orders (a customer really can order the same thing twice) and is racy without a constraint anyway; a disabled button does nothing for network retries or a second tab. A key states _intent_ explicitly.
**Limits.** It cannot stop someone deliberately creating the same order with a new key; if the page is reloaded mid-request the new form has a new key (persisting the key in `sessionStorage` would close that); keys are not purged; the key is scoped per user.

## 2. Pagination: keyset (cursor), not OFFSET

**Decision.** `WHERE (sort_col, id) < (?, ?) ORDER BY sort_col, id LIMIT 51` with an opaque base64 cursor; a partial index per sort/filter combination, `id` always the tie-breaker.
**Alternative considered.** `LIMIT/OFFSET` with page numbers.
**Why rejected.** OFFSET reads and discards every skipped row, so it slows linearly with depth, and rows inserted while scrolling shift pages (duplicates/skips). Keyset is constant-time and stable. The cost: no "jump to page 400" and no cheap total count — acceptable for an agent who searches and filters instead of paging.

## 3. Database: SQLite (+ FTS5), not PostgreSQL

**Decision.** SQLite via `better-sqlite3`, WAL mode, FTS5 for name/email search.
