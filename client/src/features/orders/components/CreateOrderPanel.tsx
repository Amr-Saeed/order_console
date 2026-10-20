import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api, money, type NewOrder } from "../../../utils/api";

interface ItemDraft {
  name: string;
  quantity: string;
  price: string;
}
const emptyItem = (): ItemDraft => ({ name: "", quantity: "1", price: "" });

const toCents = (price: string) => Math.round(Number(price) * 100);

/** Client-side validation. The server validates again — this only gives faster feedback. */
function validate(name: string, email: string, items: ItemDraft[]): string[] {
  const errors: string[] = [];
  if (!name.trim()) errors.push("Customer name is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
    errors.push("Enter a valid email.");
  if (items.length === 0) errors.push("Add at least one item.");
  items.forEach((it, i) => {
    if (!it.name.trim()) errors.push(`Item ${i + 1}: name is required.`);
    if (!Number.isInteger(Number(it.quantity)) || Number(it.quantity) < 1)
      errors.push(
        `Item ${i + 1}: quantity must be a whole number of 1 or more.`,
      );
    if (!(Number(it.price) > 0))
      errors.push(`Item ${i + 1}: price must be above 0.`);
  });
  return errors;
}

export function CreateOrderPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [items, setItems] = useState<ItemDraft[]>([emptyItem()]);
  const [errors, setErrors] = useState<string[]>([]);

  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );

  const create = useMutation({
    mutationFn: (order: NewOrder) => api.createOrder(order, idempotencyKey),
    retry: 2,
    onSuccess: async () => {
      await qc.refetchQueries({ queryKey: ["orders"], type: "active" });
      await qc.invalidateQueries({ queryKey: ["order-stats"] });
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 422) {
        setIdempotencyKey(crypto.randomUUID());
        setErrors([
          "An earlier attempt with different details was already saved. Check the orders list, then submit again to create a new order.",
        ]);
      } else if (err instanceof ApiError && err.issues) {
        setErrors(err.issues.map((i) => i.message));
      } else setErrors([err.message]);
    },
  });

  const total = items.reduce(
    (s, it) => s + (Number(it.quantity) || 0) * (toCents(it.price) || 0),
    0,
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (create.isPending) return;
    const errs = validate(name, email, items);
    setErrors(errs);
    if (errs.length) return;
    create.mutate({
      customerName: name.trim(),
      customerEmail: email.trim(),
      items: items.map((it) => ({
        name: it.name.trim(),
        quantity: Number(it.quantity),
        unitCents: toCents(it.price),
      })),
    });
  }

  const setItem = (i: number, patch: Partial<ItemDraft>) =>
    setItems(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  return (
    <div className="overlay" onClick={onClose}>
      <form
        className="panel stack"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        noValidate
        aria-label="Create order"
      >
        <h2>New order</h2>
        <label>
          Customer name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            maxLength={100}
          />
        </label>
        <label>
          Customer email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={200}
          />
        </label>

        <fieldset className="stack">
          <legend>Items</legend>
          {items.map((it, i) => (
            <div className="item-row" key={i}>
              <input
                placeholder="Item"
                aria-label={`Item ${i + 1} name`}
                value={it.name}
                onChange={(e) => setItem(i, { name: e.target.value })}
              />
              <input
                className="num"
                placeholder="Qty"
                aria-label={`Item ${i + 1} quantity`}
                inputMode="numeric"
                value={it.quantity}
                onChange={(e) => setItem(i, { quantity: e.target.value })}
              />
              <input
                className="num"
                placeholder="Price"
                aria-label={`Item ${i + 1} unit price`}
                inputMode="decimal"
                value={it.price}
                onChange={(e) => setItem(i, { price: e.target.value })}
              />
              <button
                type="button"
                className="btn tiny"
                disabled={items.length === 1}
                onClick={() => setItems(items.filter((_, j) => j !== i))}
                aria-label={`Remove item ${i + 1}`}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn"
            disabled={items.length >= 10}
            onClick={() => setItems([...items, emptyItem()])}
          >
            Add item
          </button>
        </fieldset>

        <p className="total">
          Total <strong>{money(total)}</strong>
        </p>

        {errors.length > 0 && (
          <ul className="error" role="alert">
            {errors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
        {create.isPending && create.failureCount > 0 && (
          <p className="muted">Connection problem — retrying safely…</p>
        )}

        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={create.isPending}>
            {create.isPending ? "Saving…" : "Create order"}
          </button>
        </div>
      </form>
    </div>
  );
}
