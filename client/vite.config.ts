import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The browser only ever talks to Vite (same origin); /api is proxied to the Node server.
// Same origin = the httpOnly cookie "just works" and no CORS is needed.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:3001" } },
});
