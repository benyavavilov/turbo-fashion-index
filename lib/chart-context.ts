import type { TrendDatum } from "@/app/actions";

export type Timeframe = "6M" | "1Y" | "5Y";

export interface ChartContext {
  timeframe: Timeframe;
  ratioMode: boolean;
  numerator?: string;
  denominator?: string;
  selectedEntities: string[];
  showSMA: boolean;
  showStockOverlay: boolean;
  stockOverlayEntity?: string;
  stockTicker?: string;
  recentDataPoints: TrendDatum[];
  observationCount: number;
  isLive: boolean;
}
