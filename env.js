/**
 * env.js — zero-dependency .env loader
 * Reads .env from project root and injects into process.env.
 * Call loadEnv() at the top of any entry file before reading process.env.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadEnv() {
  const envPath = resolve(__dirname, ".env");

  let raw;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    // No .env file — rely on shell environment (fine for production/AWS)
    return;
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;      // skip blanks + comments
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key   = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, ""); // strip optional quotes
    if (!(key in process.env)) process.env[key] = value;   // shell env wins over .env
  }
}
