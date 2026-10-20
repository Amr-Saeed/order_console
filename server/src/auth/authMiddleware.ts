import type { NextFunction, Request, Response } from "express";
import type { AuthService, Role, AuthUser } from "./authService";

declare global {
  namespace Express {
    interface Request { user?: AuthUser }
  }
}

export function requireAuth(auth: AuthService) {
  return (req: Request, res: Response, next: NextFunction) => {
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const token = req.cookies.token ?? bearer;
    if (!token) return res.status(401).json({ error: "Not signed in" });
    const user = auth.findUserFromToken(token);
    if (!user) return res.status(401).json({ error: "Invalid or expired session" });
    req.user = user;
    next();
  };
}

export function requireRole(authenticatedRole: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== authenticatedRole) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}
