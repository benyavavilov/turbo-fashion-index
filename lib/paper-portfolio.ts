export type PortfolioSide = "LONG" | "SHORT";

export type ExitVerdict = "HOLD" | "TAKE PROFITS" | "SELL/CUT LOSSES";

export interface PaperPosition {
  id: string;
  ticker: string;
  brand: string;
  strategy: string;
  strategyId: string;
  side: PortfolioSide;
  buyPrice: number;
  buyDate: string;
  addedAt: string;
}

export interface PositionAdvice {
  ticker: string;
  verdict: ExitVerdict;
  rationale: string;
}

const STORAGE_KEY = "turbo-fashion-paper-portfolio-v1";

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export function loadPositions(): PaperPosition[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PaperPosition[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function savePositions(positions: PaperPosition[]): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
}

export function makePositionId(ticker: string, strategyId: string): string {
  return `${ticker}__${strategyId}__${Date.now()}`;
}

export function computePnlPct(
  side: PortfolioSide,
  buyPrice: number,
  currentPrice: number
): number {
  if (!buyPrice || buyPrice <= 0) return 0;
  if (side === "SHORT") {
    return ((buyPrice - currentPrice) / buyPrice) * 100;
  }
  return ((currentPrice - buyPrice) / buyPrice) * 100;
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPnl(pct: number): string {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

export function isBullishVerdict(verdict: string): boolean {
  const v = verdict.toUpperCase();
  return (
    v.includes("BUY") ||
    v.includes("LONG") ||
    v.includes("ACCUMULATE") ||
    v.includes("PROJECTED UP") ||
    v === "UP"
  );
}

export function isBearishVerdict(verdict: string): boolean {
  const v = verdict.toUpperCase();
  return (
    v.includes("SHORT") ||
    v.includes("SELL") ||
    v.includes("CUT") ||
    v.includes("EXIT") ||
    v.includes("PROJECTED DOWN") ||
    v === "DOWN"
  );
}
