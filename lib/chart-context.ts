import type { TrendDatum } from "@/lib/chart-data";

export type Timeframe = "6M" | "1Y" | "5Y";

export interface PinnedDataPoint {
  date: string;
  /** All active series values at this date (entity names, __stock, __sma keys). */
  values: Record<string, number>;
}

export interface ChartContext {
  timeframe: Timeframe;
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
  pinnedData?: PinnedDataPoint | null;
}
