import { buildApp } from "./app";
import { assertConfig, config } from "./config";
import { openDb } from "./db";

assertConfig();
const app = await buildApp({
  db: openDb(config.dbPath),
  jwtSecret: config.jwtSecret,
  secureCookies: config.isProd,
  debugDelay: config.debugDelay && !config.isProd,
  logger: true,
});
await app.listen({ port: config.port, host: "127.0.0.1" });
