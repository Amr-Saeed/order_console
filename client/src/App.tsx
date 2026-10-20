import { useQuery } from "@tanstack/react-query";
import { Login } from "./features/auth/components/Login";
import { ApiError, api } from "./utils/api";
import { OrdersPage } from "./pages/OrdersPage";

export function App() {
  const me = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
  });

  if (me.isPending) return <p className="center muted">Loading…</p>;
  if (!me.data) return <Login />;
  return <OrdersPage user={me.data} />;
}
