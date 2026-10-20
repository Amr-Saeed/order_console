import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CreateOrderPanel } from "../features/orders/components/CreateOrderPanel";
import { OrdersList } from "../features/orders/components/OrdersList";
import { StatsPanel } from "../features/orders/components/StatsPanel";
import { api, type User } from "../utils/api";

export function OrdersPage({ user }: { user: User }) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);

  return (
    <div className="shell">
      <header className="topbar">
        <h1>Orders Console</h1>
        <div className="topbar-right">
          <button className="btn primary" onClick={() => setCreating(true)}>New order</button>
          <span className="muted">Role: {user.role}</span>
          <button className="btn" onClick={async () => {
            await api.logout();
            await qc.resetQueries({ queryKey: ["me"] });
            qc.removeQueries({ predicate: (query) => query.queryKey[0] !== "me" });
          }}>
            Sign out
          </button>
        </div>
      </header>
      <StatsPanel />
      <OrdersList user={user} />
      {creating && <CreateOrderPanel onClose={() => setCreating(false)} />}
    </div>
  );
}
