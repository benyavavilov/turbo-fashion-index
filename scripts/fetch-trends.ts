/**
 * fetch-trends.ts
 *
 * Backend data-ingestion engine for the TurboFashion Index.
 *
 * Flow:
 *   1. Seed the `tracked_entities` table with the brands / style movements we track.
 *   2. For each entity, query Google Trends "interest over time" for the last 5 years
 *      through the current date (explicit startTime + endTime).
 *   3. Parse the timeline and upsert the normalized metrics into `market_metrics`.
 *
 * Run with:  npm run fetch:trends
 * (loads .env.local via Node's --env-file flag; see package.json)
 *
 * Expected Supabase schema (see comments at the bottom of this file):
 *   tracked_entities(id uuid pk default gen_random_uuid(), name text unique, category text)
 *   market_metrics(id uuid pk default gen_random_uuid(), entity_id uuid fk,
 *                  recorded_date date, interest_value int,
 *                  unique(entity_id, recorded_date))
 */

import { createClient } from "@supabase/supabase-js";
import googleTrends from "google-trends-api";

import { entities } from "../lib/entities";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Humanized jitter window between requests. Instead of a predictable static
 * pause we sleep a random duration in this range to look less bot-like and
 * reduce the odds of tripping Google's CAPTCHA wall.
 */
const JITTER_MIN_MS = 12000;
const JITTER_MAX_MS = 22000;

/** Retry loop settings for the CAPTCHA / non-JSON response wall. */
const MAX_ATTEMPTS = 3;
const COOLDOWN_MS = 30000;

/**
 * Smart-resumption threshold. If an entity already has at least this many
 * points AND a recent latest date, we skip the Google Trends fetch.
 */
const FRESH_DATA_THRESHOLD = 250;

/** How many years of weekly search history to request from Google Trends. */
const YEARS_OF_HISTORY = 5;

/** Canonical entity catalog — synced with lib/entities.ts */
const TRACKED_ENTITIES = entities.map(({ name, category }) => ({
  name,
  category,
}));

type TrackedEntity = (typeof TRACKED_ENTITIES)[number];

// ---------------------------------------------------------------------------
// Supabase client (service role -> bypasses Row-Level Security for backend writes)
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Missing Supabase credentials. Ensure NEXT_PUBLIC_SUPABASE_URL and " +
      "SUPABASE_SERVICE_ROLE_KEY are set in .env.local."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// Types describing the Google Trends payload we care about
// ---------------------------------------------------------------------------

interface TimelinePoint {
  time: string; // unix seconds (as a string)
  formattedTime: string;
  formattedAxisTime: string;
  value: number[];
  hasData?: boolean[];
}

interface InterestOverTimePayload {
  default: {
    timelineData: TimelinePoint[];
  };
}

interface MetricRow {
  entity_id: string;
  recorded_date: string; // YYYY-MM-DD
  interest_value: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Random integer in [min, max] — our "humanized" inter-request delay. */
function randomJitterMs(min = JITTER_MIN_MS, max = JITTER_MAX_MS): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function historyWindow(): { startTime: Date; endTime: Date } {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime());
  startTime.setFullYear(startTime.getFullYear() - YEARS_OF_HISTORY);
  return { startTime, endTime };
}

/**
 * Seed the tracked entities and return a map of name -> database UUID.
 * Uses upsert on the unique `name` column so re-runs are idempotent.
 */
async function seedEntities(): Promise<Map<string, string>> {
  console.log(`\n[1/2] Seeding ${TRACKED_ENTITIES.length} tracked entities...`);

  const { data, error } = await supabase
    .from("tracked_entities")
    .upsert(TRACKED_ENTITIES, { onConflict: "name" })
    .select("id, name");

  if (error) {
    throw new Error(`Failed to seed tracked_entities: ${error.message}`);
  }

  const idByName = new Map<string, string>();
  for (const row of data ?? []) {
    idByName.set(row.name as string, row.id as string);
  }

  console.log(`      -> ${idByName.size} entities present with UUIDs.`);
  return idByName;
}

/**
 * Smart resumption: how many metric points does this entity already have,
 * and what is the newest recorded_date? Count alone is not enough — a large
 * stale series ending in 2023 would otherwise skip forever.
 */
async function existingMetricFreshness(
  entityId: string
): Promise<{ count: number; latestDate: string | null }> {
  const { count, error: countError } = await supabase
    .from("market_metrics")
    .select("id", { count: "exact", head: true })
    .eq("entity_id", entityId);

  if (countError) {
    console.warn(`      (count check failed: ${countError.message})`);
    return { count: 0, latestDate: null };
  }

  const { data: latestRows, error: latestError } = await supabase
    .from("market_metrics")
    .select("recorded_date")
    .eq("entity_id", entityId)
    .order("recorded_date", { ascending: false })
    .limit(1);

  if (latestError) {
    console.warn(`      (latest-date check failed: ${latestError.message})`);
    return { count: count ?? 0, latestDate: null };
  }

  const latestDate =
    latestRows?.[0]?.recorded_date != null
      ? String(latestRows[0].recorded_date).slice(0, 10)
      : null;

  return { count: count ?? 0, latestDate };
}

function isTrendHistoryFresh(count: number, latestDate: string | null): boolean {
  if (count <= FRESH_DATA_THRESHOLD) return false;
  if (!latestDate) return false;
  const latestMs = new Date(`${latestDate}T12:00:00`).getTime();
  if (Number.isNaN(latestMs)) return false;
  const maxAgeMs = 45 * 24 * 60 * 60 * 1000;
  return Date.now() - latestMs <= maxAgeMs;
}

/**
 * Query Google Trends for one keyword and return normalized metric rows.
 * Throws when Google returns HTML instead of JSON (the CAPTCHA / rate-limit wall).
 */
async function fetchMetricsForEntity(
  entity: TrackedEntity,
  entityId: string,
  startTime: Date,
  endTime: Date
): Promise<MetricRow[]> {
  const raw = await googleTrends.interestOverTime({
    keyword: entity.name,
    startTime,
    endTime,
  });

  let payload: InterestOverTimePayload;
  try {
    payload = JSON.parse(raw) as InterestOverTimePayload;
  } catch {
    // Google returned an HTML page (e.g. "<HEAD>...") instead of JSON — CAPTCHA wall.
    throw new Error(
      `Non-JSON response for "${entity.name}" (CAPTCHA / rate-limit wall).`
    );
  }

  const timeline = payload?.default?.timelineData ?? [];

  return timeline
    .filter((point) => Array.isArray(point.value) && point.value.length > 0)
    .map((point) => {
      const recordedDate = new Date(Number(point.time) * 1000)
        .toISOString()
        .slice(0, 10);
      return {
        entity_id: entityId,
        recorded_date: recordedDate,
        interest_value: point.value[0],
      };
    });
}

/**
 * Retry wrapper with exponential backoff. When the parse fails (CAPTCHA wall),
 * we warn, let the IP cool down for an exponentially growing interval, and try
 * that same brand again — up to MAX_ATTEMPTS times.
 */
async function fetchMetricsWithRetry(
  entity: TrackedEntity,
  entityId: string,
  startTime: Date,
  endTime: Date
): Promise<MetricRow[]> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchMetricsForEntity(entity, entityId, startTime, endTime);
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);

      if (attempt < MAX_ATTEMPTS) {
        // Exponential backoff: 30s, 60s, 120s, ...
        const cooldown = COOLDOWN_MS * 2 ** (attempt - 1);
        console.warn(
          `      ! ${entity.name}: attempt ${attempt}/${MAX_ATTEMPTS} failed (${message}). ` +
            `Cooling down ${(cooldown / 1000).toFixed(0)}s before retry...`
        );
        await sleep(cooldown);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed after ${MAX_ATTEMPTS} attempts.`);
}

/**
 * Upsert a batch of metric rows, de-duplicating on (entity_id, recorded_date).
 */
async function persistMetrics(rows: MetricRow[]): Promise<void> {
  if (rows.length === 0) return;

  const { error } = await supabase
    .from("market_metrics")
    .upsert(rows, { onConflict: "entity_id, recorded_date" });

  if (error) {
    throw new Error(`Failed to upsert market_metrics: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const startedAt = Date.now();
  console.log("=== TurboFashion Index :: Trends ingestion ===");

  const idByName = await seedEntities();
  const { startTime, endTime } = historyWindow();

  console.log(
    `\n[2/2] Fetching ${YEARS_OF_HISTORY}-year search interest for ${TRACKED_ENTITIES.length} entities` +
      ` (${startTime.toISOString().slice(0, 10)} → ${endTime.toISOString().slice(0, 10)})...`
  );

  let totalRows = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < TRACKED_ENTITIES.length; i++) {
    const entity = TRACKED_ENTITIES[i];
    const position = `${String(i + 1).padStart(2, "0")}/${TRACKED_ENTITIES.length}`;
    const entityId = idByName.get(entity.name);

    if (!entityId) {
      console.warn(`  ${position}  ${entity.name}: no UUID found, skipping.`);
      failed++;
      continue;
    }

    // Smart resumption: skip only when volume is high AND last point is recent.
    const { count: existing, latestDate } =
      await existingMetricFreshness(entityId);
    if (isTrendHistoryFresh(existing, latestDate)) {
      skipped++;
      console.log(
        `  ${position}  Skipping ${entity.name} - Data already fresh (${existing} points, latest ${latestDate}).`
      );
      continue;
    }
    if (existing > FRESH_DATA_THRESHOLD && latestDate) {
      console.log(
        `  ${position}  Refreshing ${entity.name} - volume ok (${existing}) but stale (latest ${latestDate}).`
      );
    }

    let fetchedThisEntity = false;
    try {
      const rows = await fetchMetricsWithRetry(
        entity,
        entityId,
        startTime,
        endTime
      );
      await persistMetrics(rows);
      totalRows += rows.length;
      succeeded++;
      fetchedThisEntity = true;
      console.log(
        `  ${position}  ${entity.name.padEnd(16)} -> upserted ${rows.length} data points.`
      );
    } catch (err) {
      failed++;
      fetchedThisEntity = true;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ${position}  ${entity.name.padEnd(16)} -> FAILED: ${message}`);
    }

    // Humanized jitter: only pause when we actually hit the network, and never
    // after the final entity.
    if (fetchedThisEntity && i < TRACKED_ENTITIES.length - 1) {
      const delay = randomJitterMs();
      console.log(`      … waiting ${(delay / 1000).toFixed(1)}s (jitter)`);
      await sleep(delay);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("\n=== Ingestion complete ===");
  console.log(`  Entities OK      : ${succeeded}`);
  console.log(`  Entities skipped : ${skipped}`);
  console.log(`  Entities KO      : ${failed}`);
  console.log(`  Data points      : ${totalRows}`);
  console.log(`  Elapsed          : ${elapsed}s`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFatal error during ingestion:", err);
    process.exit(1);
  });

/*
-- Supabase schema this engine expects. Run once in the SQL editor:
--
-- create extension if not exists "pgcrypto";
--
-- create table if not exists tracked_entities (
--   id uuid primary key default gen_random_uuid(),
--   name text not null unique,
--   category text not null default 'brand',
--   created_at timestamptz not null default now()
-- );
--
-- create table if not exists market_metrics (
--   id uuid primary key default gen_random_uuid(),
--   entity_id uuid not null references tracked_entities(id) on delete cascade,
--   recorded_date date not null,
--   interest_value int not null,
--   created_at timestamptz not null default now(),
--   unique (entity_id, recorded_date)
-- );
*/
