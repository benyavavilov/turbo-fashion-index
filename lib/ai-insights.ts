/**
 * Shared types + mappers for the pre-computed `ai_insights` ETL table.
 * Rows are parent-level (one insight per ticker); `brand` holds top child drivers.
 */

export type InsightDirection = "UP" | "DOWN" | "SAFE";

/** Home / Alpha Feed card kinds (UI labels). */
export type AlphaCardKind =
  | "PROJECTED UP"
  | "PROJECTED DOWN"
  | "SAFE OPTION";

/** Multi-strategy dashboard slots. */
export type StrategySlotId =
  | "TOP_MOMENTUM_BUY"
  | "TOP_CONTRARIAN_SHORT"
  | "SAFE_VALUE_HOLD";

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
  direction: InsightDirection;
  momentum_pct: number | null;
  correlation: number | null;
  hero_text: string;
  bullet_points: string[];
  sentiment: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
  data_point: string | null;
  average_return_pct: number | null;
  event_count: number | null;
  last_price: number | null;
  confidence_score?: number | null;
  reasoning_for_confidence?: string | null;
  generated_at: string;
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
  direction: InsightDirection;
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

export function directionToKind(direction: InsightDirection): AlphaCardKind {
  if (direction === "UP") return "PROJECTED UP";
  if (direction === "DOWN") return "PROJECTED DOWN";
  return "SAFE OPTION";
}

export function directionToVerdict(direction: InsightDirection): string {
  if (direction === "UP") return "PROJECTED UP";
  if (direction === "DOWN") return "PROJECTED DOWN";
  return "SAFE OPTION";
}

export function directionToSentiment(
  direction: InsightDirection
): "POSITIVE" | "NEGATIVE" | "NEUTRAL" {
  if (direction === "UP") return "POSITIVE";
  if (direction === "DOWN") return "NEGATIVE";
  return "NEUTRAL";
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
    if (!existing || row.generated_at > existing.generated_at) {
      byTicker.set(key, row);
    }
  }
  return [...byTicker.values()];
}

export function insightRowToCard(row: AiInsightRow): AlphaFeedCard {
  const direction = row.direction;
  const confidenceScore =
    typeof row.confidence_score === "number" &&
    Number.isFinite(row.confidence_score)
      ? Math.max(1, Math.min(10, Math.round(row.confidence_score)))
      : null;
  return {
    kind: directionToKind(direction),
    parentName: row.parent_name,
    ticker: row.ticker,
    brand: row.brand,
    heroText: row.hero_text,
    dataPoint:
      row.data_point ??
      (row.momentum_pct != null
        ? `${row.momentum_pct >= 0 ? "+" : ""}${row.momentum_pct.toFixed(1)}% YoY search`
        : "—"),
    averageReturnPct: row.average_return_pct ?? row.momentum_pct ?? 0,
    eventCount: row.event_count ?? 0,
    verdict: directionToVerdict(direction),
    bullets: asBulletList(row.bullet_points),
    lastPrice: row.last_price,
    sentiment: row.sentiment ?? directionToSentiment(direction),
    reason: row.hero_text,
    direction,
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
 * Build the three strategy slots from already-filtered query results
 * (or from a full table dump via {@link selectStrategyDashboard}).
 */
export function buildStrategySlots(input: {
  momentumBuy: AiInsightRow | null;
  contrarianShort: AiInsightRow | null;
  safeValueHold: AiInsightRow | null;
}): StrategySlot[] {
  return [
    {
      id: "TOP_MOMENTUM_BUY",
      title: "Top Momentum Buy",
      subtitle: "Strongest UP setup by YoY search growth",
      card: input.momentumBuy ? insightRowToCard(input.momentumBuy) : null,
      emptyMessage: STRATEGY_EMPTY_MESSAGE,
    },
    {
      id: "TOP_CONTRARIAN_SHORT",
      title: "Top Contrarian Short",
      subtitle: "Sharpest DOWN setup by search fade",
      card: input.contrarianShort
        ? insightRowToCard(input.contrarianShort)
        : null,
      emptyMessage: STRATEGY_EMPTY_MESSAGE,
    },
    {
      id: "SAFE_VALUE_HOLD",
      title: "Safe Value Hold",
      subtitle: "Best SAFE setup by correlation / momentum",
      card: input.safeValueHold ? insightRowToCard(input.safeValueHold) : null,
      emptyMessage: STRATEGY_EMPTY_MESSAGE,
    },
  ];
}

/**
 * Client-side picker when a single SELECT * dump is available.
 * Prefer dedicated ordered queries in the API when possible.
 */
export function selectStrategyDashboard(rows: AiInsightRow[]): StrategySlot[] {
  const parents = dedupeParentInsights(rows);

  const momentumBuy =
    [...parents]
      .filter((r) => r.direction === "UP")
      .sort((a, b) => (b.momentum_pct ?? -Infinity) - (a.momentum_pct ?? -Infinity))[0] ??
    null;

  const contrarianShort =
    [...parents]
      .filter((r) => r.direction === "DOWN")
      .sort((a, b) => (a.momentum_pct ?? Infinity) - (b.momentum_pct ?? Infinity))[0] ??
    null;

  const safeValueHold =
    [...parents]
      .filter((r) => r.direction === "SAFE")
      .sort((a, b) => {
        const corrDelta =
          Math.abs(b.correlation ?? 0) - Math.abs(a.correlation ?? 0);
        if (corrDelta !== 0) return corrDelta;
        return (b.momentum_pct ?? -Infinity) - (a.momentum_pct ?? -Infinity);
      })[0] ?? null;

  return buildStrategySlots({
    momentumBuy,
    contrarianShort,
    safeValueHold,
  });
}

/**
 * Top N high-conviction insights: confidence_score DESC, then |momentum_pct| DESC.
 */
export function selectHighConvictionInsights(
  rows: AiInsightRow[],
  limit = 6
): AlphaFeedCard[] {
  const ranked = dedupeParentInsights(rows).sort((a, b) => {
    const ac = a.confidence_score ?? -1;
    const bc = b.confidence_score ?? -1;
    if (bc !== ac) return bc - ac;
    const am = Math.abs(a.momentum_pct ?? 0);
    const bm = Math.abs(b.momentum_pct ?? 0);
    if (bm !== am) return bm - am;
    return Math.abs(b.correlation ?? 0) - Math.abs(a.correlation ?? 0);
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
  return {
    headline: best.hero_text,
    heroText: best.hero_text,
    sentiment: best.sentiment ?? directionToSentiment(best.direction),
    direction: best.direction,
    bullets,
    found: true,
    dataPoint: best.data_point,
    brand: best.brand,
    generatedAt: best.generated_at,
    confidenceScore,
    confidenceLabel: formatConfidenceLabel(confidenceScore),
    confidenceReason: best.reasoning_for_confidence?.trim() || null,
  };
}

export { firstRow };

export const INSIGHT_GENERATING_FALLBACK =
  "Insight currently generating. Check back after the next pipeline update.";
