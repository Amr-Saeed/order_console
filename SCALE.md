# SCALE – 5 million orders, 3 developers, agents in two countries

**What I'd change**
* **SQLite → PostgreSQL**, one primary + a read replica per region. Reasons: concurrent writers from several app instances, replication, online migrations. The schema, the keyset queries and the `UNIQUE (created_by, idempotency_key)` port as-is.
* **Search**: FTS5 → `pg_trgm`/GIN (substring + typo tolerance). A separate search engine only if Postgres search measurably misses the latency target — not before.
* **Latency for the second country**: app servers and read replica near each region; writes go to the primary (agents create few orders and read many, so reads dominate). Keep cursors opaque so the index design can change without a client change.
* **Operations**: structured logs with request ids, slow-query log, p95 dashboards on `/api/orders`, and an index review per new filter (every filter needs a matching partial index or it will scan 5M rows). Partition `orders` by month only if vacuum/index size actually hurts.
* **Auth**: short-lived access token + refresh rotation, central session revocation; rate limiting moves from in-memory to a shared store.
* **Idempotency**: add a TTL/purge job (e.g. 30 days) if keys move to their own table.

**What I deliberately keep**
Keyset pagination, server-side authorization with the role read from the DB, idempotency keys enforced by a constraint, TanStack Query with the filters as the cache key, Zod validation at the edge, a modular monolith. All of these already scale to 5M; none of them needs rewriting.

**What I'd refuse to build, even if asked**
* Microservices / Kafka for a three-person team — a modular monolith + Postgres has far less operational risk.
* Offset pagination or a "total pages" counter on 5M filtered rows.
* A one-click hard "delete all cancelled" — archive with a count-confirmation and an undo window instead.
* Real-time multi-user sync of the list "because it'd be nice" — nobody has asked for it and it multiplies the stale-data problem the current design solves.
* Trusting the client for authorization or for totals/prices.
