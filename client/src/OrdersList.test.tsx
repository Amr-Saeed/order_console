/**
 * R1 "rapid filter" proof, automated: change the status filter 3 times in quick succession while the
 * server answers the FIRST request last. The screen must end on the LAST filter's results, and the
 * superseded requests must have been aborted.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "./utils/api";
import { OrdersList } from "./features/orders/components/OrdersList";

const user: User = { id: 1, email: "agent@x.test", role: "agent" };

// status -> [delay ms, number of rows the "server" returns]
const SERVER: Record<string, [number, number]> = { pending: [500, 1], paid: [300, 2], cancelled: [20, 3], "": [10, 7] };

const signals: { status: string; signal: AbortSignal }[] = [];

function fakeFetch(input: RequestInfo | URL, init?: RequestInit) {
  const status = new URL(String(input), "http://x").searchParams.get("status") ?? "";
  const [delay, n] = SERVER[status];
  signals.push({ status, signal: init!.signal! });
  return new Promise<Response>((resolve, reject) => {
    const t = setTimeout(() => resolve(new Response(JSON.stringify({
      items: Array.from({ length: n }, (_, i) => ({ id: i + 1, customerName: "C", customerEmail: "c@x.test", status: status || "paid", totalCents: 100, itemCount: 1, createdAt: new Date().toISOString() })),
      nextCursor: null,
    }), { status: 200 })), delay);
    init!.signal!.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); });
  });
}

afterEach(() => { cleanup(); signals.length = 0; vi.unstubAllGlobals(); });

describe("OrdersList – stale responses", () => {
  it("never lets an earlier, slower response overwrite the latest filter", async () => {
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><OrdersList user={user} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText(/7 loaded/)).toBeTruthy()); // initial (no filter)

    const select = screen.getByLabelText("Filter by status");
    const ui = userEvent.setup();
    await ui.selectOptions(select, "pending");   // slowest (500 ms)
    await ui.selectOptions(select, "paid");      // slow (300 ms)
    await ui.selectOptions(select, "cancelled"); // fastest (20 ms) — and the one the user wants

    await waitFor(() => expect(screen.getByText(/Showing cancelled/)).toBeTruthy());
    expect(screen.getByText(/3 loaded/)).toBeTruthy();

    await new Promise((r) => setTimeout(r, 700)); // let every slower request "finish"
    expect(screen.getByText(/Showing cancelled/)).toBeTruthy();
    expect(screen.getByText(/3 loaded/)).toBeTruthy(); // still the latest filter's data
    expect(screen.queryByText(/1 loaded/)).toBeNull();
    expect(screen.queryByText(/2 loaded/)).toBeNull();

    const aborted = signals.filter((s) => s.signal.aborted).map((s) => s.status);
    expect(aborted).toEqual(expect.arrayContaining(["pending", "paid"])); // superseded requests were cancelled
  });
});
