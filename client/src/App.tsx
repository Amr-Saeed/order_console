import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "./api";
import { CreateOrderPanel } from "./CreateOrderPanel";
import { Login } from "./Login";
import { OrdersList } from "./OrdersList";

export function App() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const me = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
  });

  if (me.isPending) return <p className="center muted">Loading…</p>;
  if (!me.data) return <Login />;
  const user = me.data;

  return (
    <div className="shell">
      <header className="topbar">
        <h1>Orders Console</h1>
        <div className="topbar-right">
          <button className="btn primary" onClick={() => setCreating(true)}>New order</button>
          <span className="muted">{user.email} · {user.role}</span>
          <button className="btn" onClick={async () => { await api.logout(); qc.clear(); await qc.invalidateQueries({ queryKey: ["me"] }); }}>
            Sign out
          </button>
        </div>
      </header>
      <OrdersList user={user} />
      {creating && <CreateOrderPanel onClose={() => setCreating(false)} />}
    </div>
  );
}
