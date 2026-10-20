import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState } from "react";
import { useDebounced } from "../../../hooks/useDebounced";
import {
  STATUSES,
  api,
  money,
  type Order,
  type Status,
  type User,
} from "../../../utils/api";

const ROW_HEIGHT = 48;
const COLUMNS = "72px 1.3fr 1.6fr 110px 110px 60px 120px 80px";

export function OrdersList({ user }: { user: User }) {
  const qc = useQueryClient();
  const [searchInput, setSearchInput] = useState("");
  const [status, setStatus] = useState<Status | "">("");
  const [sort, setSort] = useState<"date" | "amount">("date");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [slowNetwork, setSlowNetwork] = useState(false);
  const search = useDebounced(searchInput.trim(), 250);

  const filters = { search, status, sort, dir };
  const query = useInfiniteQuery({
    queryKey: ["orders", filters],
    queryFn: ({ pageParam, signal }) =>
      api.listOrders(
        {
          search,
          status,
          sort,
          dir,
          cursor: pageParam,

          delayMs:
            import.meta.env.DEV && slowNetwork
              ? String(Math.floor(Math.random() * 2500))
              : undefined,
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: query.hasNextPage ? rows.length + 1 : rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  const items = virtualizer.getVirtualItems();

  const lastIndex = items.at(-1)?.index ?? -1;
  useEffect(() => {
    if (
      lastIndex >= rows.length - 1 &&
      query.hasNextPage &&
      !query.isFetchingNextPage &&
      !query.isPlaceholderData
    ) {
      void query.fetchNextPage();
    }
  }, [
    lastIndex,
    rows.length,
    query.hasNextPage,
    query.isFetchingNextPage,
    query.isPlaceholderData,
    query.fetchNextPage,
  ]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [search, status, sort, dir]);

  const remove = useMutation({
    mutationFn: (order: Order) => api.deleteOrder(order.id),
    onSuccess: (_result, deletedOrder) => {
      qc.setQueryData<{
        byStatus: Record<Status, number>;
        revenueTodayCents: number;
      }>(["order-stats"], (current) => {
        if (!current) return current;
        const isToday =
          new Date(deletedOrder.createdAt).toDateString() ===
          new Date().toDateString();
        return {
          ...current,
          byStatus: {
            ...current.byStatus,
            [deletedOrder.status]: Math.max(
              0,
              current.byStatus[deletedOrder.status] - 1,
            ),
          },
          revenueTodayCents: isToday
            ? Math.max(0, current.revenueTodayCents - deletedOrder.totalCents)
            : current.revenueTodayCents,
        };
      });
      void qc.refetchQueries({ queryKey: ["orders"], type: "active" });
      void qc.refetchQueries({ queryKey: ["order-stats"], type: "active" });
    },
  });

  const showingFor = query.isPlaceholderData ? "Updating…" : describe(filters);

  return (
    <section className="list">
      <div className="toolbar">
        <input
          type="search"
          className="grow"
          placeholder="Search customer name or email"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          aria-label="Search orders"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as Status | "")}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as "date" | "amount")}
          aria-label="Sort by"
        >
          <option value="date">Sort: date</option>
          <option value="amount">Sort: amount</option>
        </select>
        <button
          className="btn"
          onClick={() => setDir(dir === "asc" ? "desc" : "asc")}
          aria-label="Toggle sort direction"
        >
          {dir === "asc" ? "Ascending" : "Descending"}
        </button>
        {import.meta.env.DEV && (
          <label
            className="check"
            title="Adds a random 0–2.5 s server delay to each list request"
          >
            <input
              type="checkbox"
              checked={slowNetwork}
              onChange={(e) => setSlowNetwork(e.target.checked)}
            />{" "}
            Simulate slow network
          </label>
        )}
      </div>

      <p className="muted status-line" aria-live="polite">
        {showingFor} · {rows.length.toLocaleString()} loaded
        {query.hasNextPage ? " (scroll for more)" : ""}
      </p>

      <div className="table-head" style={{ gridTemplateColumns: COLUMNS }}>
        <span>ID</span>
        <span>Customer</span>
        <span>Email</span>
        <span>Status</span>
        <span className="num">Total</span>
        <span className="num">Items</span>
        <span>Created</span>
        <span />
      </div>

      <div
        ref={scrollRef}
        className={`scroller${query.isPlaceholderData ? " stale" : ""}`}
      >
        {query.isError && (
          <p className="error pad" role="alert">
            Could not load orders: {query.error.message}{" "}
            <button className="btn" onClick={() => query.refetch()}>
              Retry
            </button>
          </p>
        )}
        {query.isSuccess && rows.length === 0 && (
          <p className="muted pad">No orders match these filters.</p>
        )}
        <div
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        >
          {items.map((v) => {
            const order: Order | undefined = rows[v.index];
            return (
              <div
                key={v.key}
                className="row"
                style={{
                  transform: `translateY(${v.start}px)`,
                  height: ROW_HEIGHT,
                  gridTemplateColumns: COLUMNS,
                }}
              >
                {order ? (
                  <>
                    <span className="muted">#{order.id}</span>
                    <span className="ellipsis">{order.customerName}</span>
                    <span className="ellipsis muted">
                      {order.customerEmail}
                    </span>
                    <span>
                      <span className={`chip ${order.status}`}>
                        {order.status}
                      </span>
                    </span>
                    <span className="num">{money(order.totalCents)}</span>
                    <span className="num">{order.itemCount}</span>
                    <span className="muted">
                      {new Date(order.createdAt).toLocaleDateString()}
                    </span>
                    <span>
                      {user.role === "admin" && (
                        <button
                          className="btn tiny danger"
                          disabled={remove.isPending}
                          onClick={() =>
                            confirm(`Delete order #${order.id}?`) &&
                            remove.mutate(order)
                          }
                        >
                          Delete
                        </button>
                      )}
                    </span>
                  </>
                ) : (
                  <span className="muted">Loading more…</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function describe(f: {
  search: string;
  status: string;
  sort: string;
  dir: string;
}) {
  const parts = [
    f.search && `“${f.search}”`,
    f.status && f.status,
    `by ${f.sort} ${f.dir}`,
  ].filter(Boolean);
  return `Showing ${parts.join(", ")}`;
}
