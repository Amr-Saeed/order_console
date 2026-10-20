import "dotenv/config";

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3001),
  dbPath: env.DB_PATH ?? "./data/orders.db",
  jwtSecret: env.JWT_SECRET ?? "",
  isProd: env.NODE_ENV === "production",
  /** Dev-only: lets GET /api/orders accept ?delayMs= so we can prove stale responses are ignored. */
  debugDelay: env.ENABLE_DEBUG_DELAY === "1",
};

export function assertConfig() {
  if (config.jwtSecret.length < 32) {
    throw new Error("JWT_SECRET is missing or shorter than 32 characters. Run `npm install` or create server/.env from .env.example.");
  }
}
