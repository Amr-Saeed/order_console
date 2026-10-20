import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../../utils/api";

export function Login() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("agent@sarh.test");
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: () => api.login(email, password),
    onSuccess: (user) => qc.setQueryData(["me"], user),
  });

  return (
    <main className="login">
      <h1>Orders Console</h1>
      <p className="muted">Sign in to search and register orders.</p>
      <form onSubmit={(e) => { e.preventDefault(); login.mutate(); }} className="stack">
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {login.error && <p className="error" role="alert">{login.error.message}</p>}
        <button className="btn primary" disabled={login.isPending}>{login.isPending ? "Signing in…" : "Sign in"}</button>
      </form>
    </main>
  );
}
