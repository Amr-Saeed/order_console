import { Router } from "express";
import type { AuthService } from "./authService";
import { COOKIE_NAME, TOKEN_TTL_SECONDS } from "./authService";
import { requireAuth } from "./authMiddleware";
import { z } from "zod";

const loginSchema = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

export function createAuthRoutes(auth: AuthService, secureCookies: boolean, loginLimiter: ReturnType<typeof import("express-rate-limit").default>) {
  const router = Router();
  router.post("/login", loginLimiter, async (req, res, next) => {
    try {
      const { email, password } = loginSchema.parse(req.body);
      const user = await auth.verifyCredentials(email, password);
      if (!user) return res.status(401).json({ error: "Wrong email or password" });
      res.cookie(COOKIE_NAME, auth.sign(user), {
        httpOnly: true, sameSite: "lax", secure: secureCookies, path: "/", maxAge: TOKEN_TTL_SECONDS * 1000,
      });
      return res.json({ user });
    } catch (error) { next(error); }
  });
  router.post("/logout", (_req, res) => {
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.json({ ok: true });
  });
  router.get("/me", requireAuth(auth), (req, res) => res.json({ user: req.user }));
  return router;
}
