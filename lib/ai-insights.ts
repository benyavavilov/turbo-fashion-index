/**
 * Shared types + mappers for the pre-computed `ai_insights` ETL table.
 * Rows are parent-level (one insight per ticker); `brand` holds top child drivers.
 * Earnings Whisper: primary call is `earnings_mismatch` (BEAT / MISS / PRICED_IN).
 */

/** @deprecated Prefer EarningsMismatch — kept for legacy row fallback. */
export type InsightDirection = "UP" | "DOWN" | "SAFE";

/** Earnings Whisper mismatch vs Wall Street revenue estimates. */
export type EarningsMismatch = "BEAT_LIKELY" | "MISS_LIKELY" | "PRICED_IN";

/** Home / Alpha Feed card kinds (UI labels). */
export type AlphaCardKind = EarningsMismatch;

/** Multi-strategy dashboard slots. */
export type StrategySlotId =
  | "TOP_BEAT_LIKELY"
  | "TOP_MISS_LIKELY"
  | "TOP_PRICED_IN";

export const INSIGHT_BULLET_LABELS = [
  "The Search Trend",
  "Our Edge / History",
  "Wall Street's View",
  "Final Verdict",
] as const;

export const STRATEGY_EMPTY_MESSAGE =
  "No setups currently meet the strict criteria for this strategy.";

export type ConfidenceBand = "High" | "Medium" | "Low";

export interface AiInsightRow {
  id?: string;
  ticker: string;
  parent_name: string;
  /** Top child-brand drivers (joined), not a child-level insight key. */
  brand: string;
  /** Primary Earnings Whisper call. */
  earnings_mismatch?: EarningsMismatch | null;
  /** @deprecated Prefer earnings_mismatch. */
  direction?: InsightDirection | null;
  momentum_pct: number | null;
  correlation?: number | null;
  hero_text?: string | null;
  bullet_points?: string[] | null;
  sentiment?: "POSITIVE" | "NEGATIVE" | "NEUTRAL" | null;
  data_point?: string | null;
  average_return_pct?: number | null;
  event_count?: number | null;
  last_price?: number | null;
  confidence_score?: number | null;
  reasoning_for_confidence?: string | null;
  /** Fluid Asset Profile handbook fields (ai_insights). */
  strategy_profile?: string | null;
  wall_street_consensus?: string | null;
  expected_revenue_growth?: string | null;
  /** ISO date (YYYY-MM-DD) of the next earnings print, from Yahoo calendarEvents. */
  next_earnings_date?: string | null;
  terminal_verdict?: string | null;
  the_buzz?: string | null;
  the_risk?: string | null;
  generated_at?: string;
}

export interface AlphaFeedCard {
  kind: AlphaCardKind;
  parentName: string;
  ticker: string;
  /** Top child drivers shown as secondary signal labels. */
  brand: string;
  heroText: string;
  dataPoint: string;
  averageReturnPct: number;
  eventCount: number;
  verdict: string;
  bullets: string[];
  lastPrice: number | null;
  sentiment?: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
  reason?: string;
  earningsMismatch: EarningsMismatch;
  /** @deprecated Prefer earningsMismatch. */
  direction: InsightDirection;
  /** Sanitized YoY search growth % (momentum_pct). */
  momentumPct: number | null;
  /** Post-2024 Sniper win rate label, e.g. "4/5 • 80%". */
  historicalAccuracyLabel: string | null;
  /** Post-2024 Sniper win rate percent (0–100). */
  historicalAccuracyPct: number | null;
  expectedRevenueGrowth: string | null;
  /** Next earnings date YYYY-MM-DD when known. */
  nextEarningsDate: string | null;
  confidenceScore: number | null;
  confidenceBand: ConfidenceBand | null;
  confidenceReason: string | null;
  /** e.g. "Confidence: High / 9" */
  confidenceLabel: string | null;
}

export interface StrategySlot {
  id: StrategySlotId;
  title: string;
  subtitle: string;
  /** Populated insight card, or null when the strategy has no qualifying row. */
  card: AlphaFeedCard | null;
  emptyMessage: string;
}

export interface AlphaFeedResponse {
  strategies: StrategySlot[];
  /** @deprecated Prefer strategies — kept for older clients. */
  cards: AlphaFeedCard[];
  scannedParents: number;
  scannedBrands: number;
  generatedAt: string;
  error?: string;
}

export interface CompanyBrief {
  headline: string;
  heroText: string;
  sentiment: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
  earningsMismatch: EarningsMismatch | null;
  /** @deprecated Prefer earningsMismatch. */
  direction: InsightDirection | null;
  bullets: string[];
  /** False when no cached row exists yet. */
  found: boolean;
  dataPoint?: string | null;
  brand?: string | null;
  generatedAt?: string | null;
  confidenceScore?: number | null;
  confidenceLabel?: string | null;
  confidenceReason?: string | null;
  /** Ultimate Handbook / Asset Profile fields. */
  strategyProfile?: string | null;
  wallStreetConsensus?: string | null;
  expectedRevenueGrowth?: string | null;
  /** Sanitized YoY search growth % (momentum_pct). */
  momentumPct?: number | null;
  terminalVerdict?: string | null;
  theBuzz?: string | null;
  theRisk?: string | null;
  /** True when at least one handbook field is populated. */
  hasAssetProfile?: boolean;
}

export function confidenceBandFromScore(
  score: number | null | undefined
): ConfidenceBand | null {
  if (score == null || !Number.isFinite(score)) return null;
  if (score >= 8) return "High";
  if (score >= 5) return "Medium";
  return "Low";
}

export function formatConfidenceLabel(
  score: number | null | undefined
): string | null {
  const band = confidenceBandFromScore(score);
  if (band == null || score == null) return null;
  return `Confidence: ${band} / ${Math.round(score)}`;
}

/** Normalize Yahoo / DB next-earnings values to YYYY-MM-DD or null. */
export function normalizeNextEarningsDate(
  value: string | null | undefined
): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === "N/A") return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Normalize mismatch from new column or legacy direction. */
export function resolveEarningsMismatch(
  row: Pick<AiInsightRow, "earnings_mismatch" | "direction">
): EarningsMismatch {
  const raw = row.earnings_mismatch?.trim().toUpperCase();
  if (raw === "BEAT_LIKELY" || raw === "MISS_LIKELY" || raw === "PRICED_IN") {
    return raw;
  }
  if (row.direction === "UP") return "BEAT_LIKELY";
  if (row.direction === "DOWN") return "MISS_LIKELY";
  return "PRICED_IN";
}

export function mismatchToKind(mismatch: EarningsMismatch): AlphaCardKind {
  return mismatch;
}

export function mismatchToVerdict(mismatch: EarningsMismatch): string {
  return mismatch.replace(/_/g, " ");
}

/** High-visibility Alpha Feed / Asset Profile badge copy. */
export function mismatchToAlertBadge(mismatch: EarningsMismatch): string {
  if (mismatch === "BEAT_LIKELY") return "EARNINGS BEAT PROJECTED";
  if (mismatch === "MISS_LIKELY") return "EARNINGS MISS PROJECTED";
  return "PRICED IN";
}

/** Format YoY search growth for delta displays. */
export function formatSearchGrowthPct(
  momentumPct: number | null | undefined
): string {
  if (momentumPct == null || !Number.isFinite(momentumPct)) return "n/a";
  return `${momentumPct >= 0 ? "+" : ""}${momentumPct.toFixed(1)}%`;
}

/** Format Street revenue growth estimate for delta displays. */
export function formatExpectedRevenueGrowth(
  raw: string | null | undefined
): string {
  if (!raw || !raw.trim() || raw.trim().toUpperCase() === "N/A") return "N/A";
  return raw.trim();
}

export function mismatchToSentiment(
  mismatch: EarningsMismatch
): "POSITIVE" | "NEGATIVE" | "NEUTRAL" {
  if (mismatch === "BEAT_LIKELY") return "POSITIVE";
  if (mismatch === "MISS_LIKELY") return "NEGATIVE";
  return "NEUTRAL";
}

/** Map Earnings Whisper → legacy direction for any remaining consumers. */
export function mismatchToDirection(
  mismatch: EarningsMismatch
): InsightDirection {
  if (mismatch === "BEAT_LIKELY") return "UP";
  if (mismatch === "MISS_LIKELY") return "DOWN";
  return "SAFE";
}

/** @deprecated Prefer mismatchToKind. */
export function directionToKind(direction: InsightDirection): AlphaCardKind {
  if (direction === "UP") return "BEAT_LIKELY";
  if (direction === "DOWN") return "MISS_LIKELY";
  return "PRICED_IN";
}

/** @deprecated Prefer mismatchToVerdict. */
export function directionToVerdict(direction: InsightDirection): string {
  return mismatchToVerdict(directionToKind(direction));
}

/** @deprecated Prefer mismatchToSentiment. */
export function directionToSentiment(
  direction: InsightDirection
): "POSITIVE" | "NEGATIVE" | "NEUTRAL" {
  return mismatchToSentiment(directionToKind(direction));
}

/** Normalize to up to 4 narrative bullets (pad/truncate safely). */
export function asBulletList(points: unknown): string[] {
  const list = Array.isArray(points)
    ? points.map((p) => String(p).trim()).filter(Boolean)
    : [];
  while (list.length < 4) {
    list.push(
      list.length === 0
        ? "Insight detail unavailable."
        : "See the final verdict above for the takeaway."
    );
  }
  return list.slice(0, 4);
}

/** Keep one row per parent ticker (latest generated_at wins). */
export function dedupeParentInsights(rows: AiInsightRow[]): AiInsightRow[] {
  const byTicker = new Map<string, AiInsightRow>();
  for (const row of rows) {
    const key = row.ticker.toUpperCase();
    const existing = byTicker.get(key);
    if (
      !existing ||
      (row.generated_at ?? "") > (existing.generated_at ?? "")
    ) {
      byTicker.set(key, row);
    }
  }
  return [...byTicker.values()];
}

export function insightRowToCard(row: AiInsightRow): AlphaFeedCard {
  const earningsMismatch = resolveEarningsMismatch(row);
  const confidenceScore =
    typeof row.confidence_score === "number" &&
    Number.isFinite(row.confidence_score)
      ? Math.max(1, Math.min(10, Math.round(row.confidence_score)))
      : null;
  const terminalVerdict =
    row.terminal_verdict?.trim() || row.hero_text?.trim() || "";
  return {
    kind: mismatchToKind(earningsMismatch),
    parentName: row.parent_name,
    ticker: row.ticker,
    brand: row.brand,
    heroText: terminalVerdict,
    dataPoint:
      row.data_point ??
      (row.momentum_pct != null
        ? `${row.momentum_pct >= 0 ? "+" : ""}${row.momentum_pct.toFixed(1)}% YoY search`
        : "—"),
    averageReturnPct: row.average_return_pct ?? row.momentum_pct ?? 0,
    eventCount: row.event_count ?? 0,
    verdict: mismatchToVerdict(earningsMismatch),
    bullets: asBulletList(row.bullet_points),
    lastPrice: row.last_price ?? null,
    sentiment: row.sentiment ?? mismatchToSentiment(earningsMismatch),
    reason: terminalVerdict,
    earningsMismatch,
    direction: mismatchToDirection(earningsMismatch),
    momentumPct:
      typeof row.momentum_pct === "number" && Number.isFinite(row.momentum_pct)
        ? row.momentum_pct
        : null,
    historicalAccuracyLabel: null,
    historicalAccuracyPct: null,
    expectedRevenueGrowth: row.expected_revenue_growth?.trim() || null,
    nextEarningsDate: normalizeNextEarningsDate(row.next_earnings_date),
    confidenceScore,
    confidenceBand: confidenceBandFromScore(confidenceScore),
    confidenceReason: row.reasoning_for_confidence?.trim() || null,
    confidenceLabel: formatConfidenceLabel(confidenceScore),
  };
}

function firstRow(rows: AiInsightRow[] | null | undefined): AiInsightRow | null {
  return rows?.[0] ?? null;
}

/**
 * Build the three Earnings Whisper strategy slots.
 */
export function buildStrategySlots(input: {
  beatLikely: AiInsightRow | null;
  missLikely: AiInsightRow | null;
  pricedIn: AiInsightRow | null;
}): StrategySlot[] {
  return [
    {
      id: "TOP_BEAT_LIKELY",
      title: "Beat Likely",
      subtitle: "Search hype outpacing Street revenue estimates",
      card: input.beatLikely ? insightRowToCard(input.beatLikely) : null,
      emptyMessage: STRATEGY_EMPTY_MESSAGE,
    },
    {
      id: "TOP_MISS_LIKELY",
      title: "Miss Likely",
      subtitle: "Search demand lagging Street expectations",
      card: input.missLikely ? insightRowToCard(input.missLikely) : null,
      emptyMessage: STRATEGY_EMPTY_MESSAGE,
    },
    {
      id: "TOP_PRICED_IN",
      title: "Priced In",
      subtitle: "Hype and Street estimates roughly aligned",
      card: input.pricedIn ? insightRowToCard(input.pricedIn) : null,
      emptyMessage: STRATEGY_EMPTY_MESSAGE,
    },
  ];
}

/**
 * Client-side picker when a single SELECT * dump is available.
 */
export function selectStrategyDashboard(rows: AiInsightRow[]): StrategySlot[] {
  const parents = dedupeParentInsights(rows);

  const beatLikely =
    [...parents]
      .filter((r) => resolveEarningsMismatch(r) === "BEAT_LIKELY")
      .sort((a, b) => (b.momentum_pct ?? -Infinity) - (a.momentum_pct ?? -Infinity))[0] ??
    null;

  const missLikely =
    [...parents]
      .filter((r) => resolveEarningsMismatch(r) === "MISS_LIKELY")
      .sort((a, b) => (a.momentum_pct ?? Infinity) - (b.momentum_pct ?? Infinity))[0] ??
    null;

  const pricedIn =
    [...parents]
      .filter((r) => resolveEarningsMismatch(r) === "PRICED_IN")
      .sort(
        (a, b) =>
          Math.abs(b.momentum_pct ?? 0) - Math.abs(a.momentum_pct ?? 0)
      )[0] ?? null;

  return buildStrategySlots({
    beatLikely,
    missLikely,
    pricedIn,
  });
}

/**
 * Top N Earnings Whisper alerts: |momentum_pct| DESC (largest mismatches first).
 */
export function selectHighConvictionInsights(
  rows: AiInsightRow[],
  limit = 6
): AlphaFeedCard[] {
  const ranked = dedupeParentInsights(rows).sort((a, b) => {
    const am = Math.abs(a.momentum_pct ?? 0);
    const bm = Math.abs(b.momentum_pct ?? 0);
    if (bm !== am) return bm - am;
    return (a.ticker ?? "").localeCompare(b.ticker ?? "");
  });
  return ranked.slice(0, limit).map(insightRowToCard);
}

/**
 * Top N most notable parent insights by |momentum_pct|.
 * @deprecated Prefer selectHighConvictionInsights for the home feed.
 */
export function selectTopInsights(
  rows: AiInsightRow[],
  limit = 6
): AlphaFeedCard[] {
  return selectHighConvictionInsights(rows, limit);
}

/** @deprecated Prefer selectStrategyDashboard. */
export function selectFeaturedCards(rows: AiInsightRow[]): AlphaFeedCard[] {
  return selectStrategyDashboard(rows)
    .map((s) => s.card)
    .filter((c): c is AlphaFeedCard => c != null);
}

/** Parent-level brief for a ticker (single cached row). */
export function selectBriefForTicker(
  rows: AiInsightRow[],
  ticker: string
): CompanyBrief | null {
  const parents = dedupeParentInsights(rows).filter(
    (r) => r.ticker.toUpperCase() === ticker.toUpperCase()
  );
  if (parents.length === 0) return null;

  const best = parents[0];
  const bullets = asBulletList(best.bullet_points);
  const confidenceScore =
    typeof best.confidence_score === "number" &&
    Number.isFinite(best.confidence_score)
      ? Math.max(1, Math.min(10, Math.round(best.confidence_score)))
      : null;

  const earningsMismatch = resolveEarningsMismatch(best);
  const strategyProfile = best.strategy_profile?.trim() || null;
  const wallStreetConsensus = best.wall_street_consensus?.trim() || null;
  const expectedRevenueGrowth = best.expected_revenue_growth?.trim() || null;
  const terminalVerdict =
    best.terminal_verdict?.trim() || best.hero_text?.trim() || null;
  const theBuzz = best.the_buzz?.trim() || null;
  const theRisk = best.the_risk?.trim() || null;
  const hasAssetProfile = Boolean(
    strategyProfile || terminalVerdict || theBuzz || theRisk
  );

  return {
    headline: terminalVerdict ?? best.hero_text ?? `${best.ticker} Earnings Whisper`,
    heroText: terminalVerdict ?? best.hero_text ?? "",
    sentiment: best.sentiment ?? mismatchToSentiment(earningsMismatch),
    earningsMismatch,
    direction: mismatchToDirection(earningsMismatch),
    bullets,
    found: true,
    dataPoint: best.data_point,
    brand: best.brand,
    generatedAt: best.generated_at ?? null,
    confidenceScore,
    confidenceLabel: formatConfidenceLabel(confidenceScore),
    confidenceReason: best.reasoning_for_confidence?.trim() || null,
    strategyProfile,
    wallStreetConsensus,
    expectedRevenueGrowth,
    momentumPct:
      typeof best.momentum_pct === "number" && Number.isFinite(best.momentum_pct)
        ? best.momentum_pct
        : null,
    terminalVerdict,
    theBuzz,
    theRisk,
    hasAssetProfile,
  };
}

export { firstRow };

export const INSIGHT_GENERATING_FALLBACK =
  "Asset Profile generating… check back after the next pipeline run.";

export function formatWallStreetConsensus(
  raw: string | null | undefined
): string {
  if (!raw || !raw.trim() || raw.trim().toUpperCase() === "N/A") return "N/A";
  return raw
    .trim()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
