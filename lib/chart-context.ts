import type { TrendDatum } from "@/app/actions";

export type Timeframe = "6M" | "1Y" | "5Y";

export interface ChartContext {
  timeframe: Timeframe;
  ratioMode: boolean;
  numerator?: string;
  denominator?: string;
  selectedEntities: string[];
  showSMA: boolean;
  smaEntities?: string[];
  showStockOverlay: boolean;
  stockOverlayEntity?: string;
  stockTicker?: string;
  stockEntities?: string[];
  /** Full chart rows currently visible for the active timeframe (not truncated). */
  visibleChartData: TrendDatum[];
  observationCount: number;
  isLive: boolean;
}
