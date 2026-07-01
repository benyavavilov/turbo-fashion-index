/**
 * Local runner for the source-driven, AI-curated notification engine.
 *
 * Loads .env.local, then delegates to the shared syncNews() engine that also
 * powers the Vercel cron route (src/app/api/cron/sync-news/route.ts).
 *
 * Run:  npm run fetch-news
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { syncNews } from "../src/app/lib/news-sync";

function loadLocalEnv(): void {
  try {
    const envPath = resolve(process.cwd(), ".env.local");
    const raw = readFileSync(envPath, "utf8");

    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim().replace(/^export\s+/, "");
      if (!line || line.startsWith("#")) {
        continue;
      }

      const eq = line.indexOf("=");
      if (eq === -1) {
        continue;
      }

      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();

      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // No .env.local present — rely on the ambient environment instead.
  }
}

// Load .env.local before syncNews reads process.env.
loadLocalEnv();

const isDirectRun = process.argv[1]?.includes("fetch-news");
if (isDirectRun) {
  syncNews()
    .then((summary) => {
      console.log(
        `\nDone. ${summary.successes} synced, ${summary.skips} skipped, ${summary.errors} error(s).`,
      );
    })
    .catch((error) => {
      console.error("News fetch failed:", error);
      process.exitCode = 1;
    });
}
