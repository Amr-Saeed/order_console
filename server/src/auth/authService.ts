import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { DB } from "../db";

export type Role = "admin" | "agent";
export interface AuthUser { id: number; email: string; role: Role }

export const COOKIE_NAME = "token";
export const TOKEN_TTL_SECONDS = 8 * 60 * 60;
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

export function makeAuthService(db: DB, secret: string) {
  const findById = db.prepare("SELECT id, email, role FROM users WHERE id = ?");
  const findByEmail = db.prepare("SELECT id, email, role, password_hash FROM users WHERE email = ?");

  return {
    sign(user: AuthUser) {
      return jwt.sign({ role: user.role }, secret, {
        subject: String(user.id), expiresIn: TOKEN_TTL_SECONDS, algorithm: "HS256",
      });
    },
    async verifyCredentials(email: string, password: string): Promise<AuthUser | null> {
      const row = findByEmail.get(email) as (AuthUser & { password_hash: string }) | undefined;
      const valid = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
      return row && valid ? { id: row.id, email: row.email, role: row.role } : null;
    },
    findUserFromToken(token: string): AuthUser | null {
      try {
        const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
        const user = typeof payload === "object" && payload.sub
          ? findById.get(Number(payload.sub)) as AuthUser | undefined
          : undefined;
        return user ?? null;
      } catch {
        return null;
      }
    },
  };
}

export type AuthService = ReturnType<typeof makeAuthService>;
