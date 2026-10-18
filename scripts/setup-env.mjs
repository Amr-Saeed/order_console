// Creates server/.env from .env.example with a fresh random JWT secret (only if it doesn't exist yet).
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

if (!existsSync("server/.env")) {
  copyFileSync(".env.example", "server/.env");
  const env = readFileSync("server/.env", "utf8").replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${randomBytes(32).toString("hex")}`);
  writeFileSync("server/.env", env);
  console.log("Created server/.env with a random JWT_SECRET");
}
