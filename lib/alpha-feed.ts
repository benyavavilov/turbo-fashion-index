export type AlphaCardKind = "TOP BUY" | "TOP SHORT" | "WATCH";

export interface AlphaFeedCard {
  kind: AlphaCardKind;
  parentName: string;
  ticker: string;
  brand: string;
  dataPoint: string;
  averageReturnPct: number;
  eventCount: number;
  verdict: string;
  bullets: [string, string];
  lastPrice: number | null;
  sentiment?: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
  reason?: string;
}

export interface AlphaFeedResponse {
  cards: AlphaFeedCard[];
  scannedParents: number;
  scannedBrands: number;
  generatedAt: string;
  error?: string;
}
