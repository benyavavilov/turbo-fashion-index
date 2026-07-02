/**
 * fetch-trends.ts
 *
 * Backend data-ingestion engine for the TurboFashion Index.
 *
 * Flow:
 *   1. Seed the `tracked_entities` table with the brands / style movements we track.
 *   2. For each entity, query Google Trends "interest over time" for the last 6 months.
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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Delay between each brand's Google Trends request, to avoid 429 rate limits. */
const REQUEST_DELAY_MS = 4000;

/** How far back to pull the search-interest timeline. */
const MONTHS_OF_HISTORY = 6;

type EntityCategory = "brand" | "trend";

interface TrackedEntity {
  name: string;
  category: EntityCategory;
}

/** The 20 entities we track: 15 benchmark brands + 5 macro style movements. */
const ENTITIES: TrackedEntity[] = [
  { name: "Abercrombie", category: "brand" },
  { name: "Nike", category: "brand" },
  { name: "Lululemon", category: "brand" },
  { name: "Adidas", category: "brand" },
  { name: "Ralph Lauren", category: "brand" },
  { name: "Levi's", category: "brand" },
  { name: "Zara", category: "brand" },
  { name: "H&M", category: "brand" },
  { name: "Gap", category: "brand" },
  { name: "ASOS", category: "brand" },
  { name: "Uniqlo", category: "brand" },
  { name: "Shein", category: "brand" },
  { name: "The North Face", category: "brand" },
  { name: "New Balance", category: "brand" },
  { name: "Patagonia", category: "brand" },
  { name: "Gorpcore", category: "trend" },
  { name: "Y2K Fashion", category: "trend" },
  { name: "Quiet Luxury", category: "trend" },
  { name: "Athleisure", category: "trend" },
  { name: "Streetwear", category: "trend" },
];

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

function startOfHistoryWindow(): Date {
  const start = new Date();
  start.setMonth(start.getMonth() - MONTHS_OF_HISTORY);
  return start;
}

/**
 * Seed the tracked entities and return a map of name -> database UUID.
 * Uses upsert on the unique `name` column so re-runs are idempotent.
 */
async function seedEntities(): Promise<Map<string, string>> {
  console.log(`\n[1/2] Seeding ${ENTITIES.length} tracked entities...`);

  const { data, error } = await supabase
    .from("tracked_entities")
    .upsert(ENTITIES, { onConflict: "name" })
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
 * Query Google Trends for one keyword and return normalized metric rows.
 */
async function fetchMetricsForEntity(
  entity: TrackedEntity,
  entityId: string,
  startTime: Date
): Promise<MetricRow[]> {
  const raw = await googleTrends.interestOverTime({
    keyword: entity.name,
    startTime,
  });

  let payload: InterestOverTimePayload;
  try {
    payload = JSON.parse(raw) as InterestOverTimePayload;
  } catch {
    // Google occasionally returns an HTML error page instead of JSON (rate limits, etc.)
    throw new Error(
      `Unexpected non-JSON response for "${entity.name}" (likely a rate limit).`
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
  const startTime = startOfHistoryWindow();

  console.log(
    `\n[2/2] Fetching ${MONTHS_OF_HISTORY}-month search interest for ${ENTITIES.length} entities` +
      ` (>= ${startTime.toISOString().slice(0, 10)})...`
  );

  let totalRows = 0;
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < ENTITIES.length; i++) {
    const entity = ENTITIES[i];
    const position = `${String(i + 1).padStart(2, "0")}/${ENTITIES.length}`;
    const entityId = idByName.get(entity.name);

    if (!entityId) {
      console.warn(`  ${position}  ${entity.name}: no UUID found, skipping.`);
      failed++;
      continue;
    }

    try {
      const rows = await fetchMetricsForEntity(entity, entityId, startTime);
      await persistMetrics(rows);
      totalRows += rows.length;
      succeeded++;
      console.log(
        `  ${position}  ${entity.name.padEnd(16)} -> upserted ${rows.length} data points.`
      );
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ${position}  ${entity.name.padEnd(16)} -> FAILED: ${message}`);
    }

    // Rate-limit guard: pause between every request (skip after the last one).
    if (i < ENTITIES.length - 1) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("\n=== Ingestion complete ===");
  console.log(`  Entities OK : ${succeeded}`);
  console.log(`  Entities KO : ${failed}`);
  console.log(`  Data points : ${totalRows}`);
  console.log(`  Elapsed     : ${elapsed}s`);
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
