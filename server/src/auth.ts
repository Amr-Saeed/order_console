import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DB } from "./db";

export type Role = "admin" | "agent";
export interface AuthUser { id: number; email: string; role: Role }

declare module "fastify" {
  interface FastifyRequest { user?: AuthUser }
}

export const COOKIE_NAME = "token";
export const TOKEN_TTL_SECONDS = 8 * 60 * 60;

// Used when the email does not exist, so "unknown user" and "wrong password" take the same time.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

export function makeAuth(db: DB, secret: string) {
  const findById = db.prepare("SELECT id, email, role FROM users WHERE id = ?");
  const findByEmail = db.prepare("SELECT id, email, role, password_hash FROM users WHERE email = ?");

  const sign = (u: AuthUser) =>
    jwt.sign({ role: u.role }, secret, { subject: String(u.id), expiresIn: TOKEN_TTL_SECONDS, algorithm: "HS256" });

  async function verifyCredentials(email: string, password: string): Promise<AuthUser | null> {
    const row = findByEmail.get(email) as (AuthUser & { password_hash: string }) | undefined;
    const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
    return row && ok ? { id: row.id, email: row.email, role: row.role } : null;
  }

  /** 401 unless a valid, unexpired token (cookie or Authorization header — never the URL) is present. */
  async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    const token = req.cookies[COOKIE_NAME] ?? bearer;
    if (!token) return reply.code(401).send({ error: "Not signed in" });
    try {
      const payload = jwt.verify(token, secret, { algorithms: ["HS256"] }); // verifies signature + expiry
      // Role comes from the DB, not the token: demoted/deleted users lose access immediately.
      const user = typeof payload === "object" && payload.sub ? (findById.get(Number(payload.sub)) as AuthUser | undefined) : undefined;
      if (!user) return reply.code(401).send({ error: "Invalid session" });
      req.user = user;
    } catch {
      return reply.code(401).send({ error: "Invalid or expired session" });
    }
  }

  const requireRole = (role: Role) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.user?.role !== role) return reply.code(403).send({ error: "Forbidden" });
  };

  return { sign, verifyCredentials, requireAuth, requireRole };
}
