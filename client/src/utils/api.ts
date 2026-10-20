export type Status = "pending" | "paid" | "shipped" | "delivered" | "cancelled";
export const STATUSES: Status[] = ["pending", "paid", "shipped", "delivered", "cancelled"];

export interface Order {
  id: number; customerName: string; customerEmail: string; status: Status;
  totalCents: number; itemCount: number; createdAt: string;
}
export interface OrdersPage { items: Order[]; nextCursor: string | null }
export interface User { id: number; email: string; role: "admin" | "agent" }
export interface NewOrder { customerName: string; customerEmail: string; items: { name: string; quantity: number; unitCents: number }[] }
export interface OrderStats {
  byStatus: Record<Status, number>;
  revenueTodayCents: number;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public issues?: { path: string; message: string }[]) { super(message); }
}

async function request<T>(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<T> {
  const { idempotencyKey, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (rest.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  headers.set("x-requested-with", "orders-console");
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);

  const res = await fetch(`/api${path}`, {
    ...rest,
    credentials: "same-origin",
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, data.issues);
  return data as T;
}

export const api = {
  me: () => request<{ user: User }>("/auth/me").then((r) => r.user),
  login: (email: string, password: string) =>
    request<{ user: User }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }).then((r) => r.user),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),

  listOrders: (params: Record<string, string | undefined>, signal: AbortSignal) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return request<OrdersPage>(`/orders?${qs}`, { signal });
  },
  stats: (signal: AbortSignal) => request<OrderStats>("/orders/stats", { signal }),
  createOrder: (order: NewOrder, idempotencyKey: string) =>
    request<Order>("/orders", { method: "POST", body: JSON.stringify(order), idempotencyKey }),
  deleteOrder: (id: number) => request<{ ok: true }>(`/orders/${id}`, { method: "DELETE" }),
};

export const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
