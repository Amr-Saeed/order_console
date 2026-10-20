import { useQuery } from "@tanstack/react-query";
import { ApiError, api, money, type Status } from "../../../utils/api";

const STATUSES: Status[] = ["pending", "paid", "shipped", "delivered", "cancelled"];

export function StatsPanel() {
  const query = useQuery({
    queryKey: ["order-stats"],
    queryFn: ({ signal }) => api.stats(signal),
    retry: false,
  });

  if (query.isPending) {
    return <section className="stats-panel" aria-label="Order statistics"><p className="muted">Loading statistics (this may take a few seconds)…</p></section>;
  }

  if (query.isError) {
    const message = query.error instanceof ApiError ? query.error.message : "Could not load statistics.";
    return (
      <section className="stats-panel" aria-label="Order statistics">
        <p className="error" role="alert">{message}</p>
        <button className="btn" onClick={() => query.refetch()}>Retry statistics</button>
      </section>
    );
  }

  return (
    <section className="stats-panel" aria-label="Order statistics">
      <div className="stats-heading">
        <h2>Today at a glance</h2>
      </div>
      <div className="stats-grid">
        {STATUSES.map((status) => (
          <div className="stat" key={status}>
            <span className={`chip ${status}`}>{status}</span>
            <strong>{query.data.byStatus[status].toLocaleString()}</strong>
          </div>
        ))}
        <div className="stat revenue">
          <span className="muted">Revenue today</span>
          <strong>{money(query.data.revenueTodayCents)}</strong>
        </div>
      </div>
    </section>
  );
}
