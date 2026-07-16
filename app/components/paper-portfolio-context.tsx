"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  loadPositions,
  makePositionId,
  savePositions,
  type PaperPosition,
  type PortfolioSide,
  type PositionAdvice,
} from "@/lib/paper-portfolio";
import type { StrategyPick } from "@/lib/screener";

interface PaperPortfolioContextValue {
  positions: PaperPosition[];
  adviceByTicker: Record<string, PositionAdvice>;
  addFromStrategy: (pick: StrategyPick) => Promise<{ ok: boolean; error?: string }>;
  removePosition: (id: string) => void;
  setAdvice: (items: PositionAdvice[]) => void;
  clearAdvice: () => void;
}

const PaperPortfolioContext = createContext<PaperPortfolioContextValue | null>(
  null
);

function sideForStrategy(pick: StrategyPick): PortfolioSide {
  if (pick.strategyId === "contrarian") return "SHORT";
  const v = pick.verdict.toUpperCase();
  if (v.includes("SHORT") || v.includes("SELL") || v.includes("FADE")) {
    return "SHORT";
  }
  return "LONG";
}

export function PaperPortfolioProvider({ children }: { children: ReactNode }) {
  const [positions, setPositions] = useState<PaperPosition[]>([]);
  const [adviceByTicker, setAdviceByTicker] = useState<
    Record<string, PositionAdvice>
  >({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setPositions(loadPositions());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    savePositions(positions);
  }, [positions, hydrated]);

  const addFromStrategy = useCallback(async (pick: StrategyPick) => {
    let buyPrice = pick.lastPrice ?? null;

    if (buyPrice == null || buyPrice <= 0) {
      try {
        const res = await fetch(
          `/api/finance?ticker=${encodeURIComponent(pick.ticker)}&timeframe=6M`
        );
        const data = (await res.json()) as {
          quotes?: { date: string; close: number }[];
          error?: string;
        };
        const quotes = data.quotes ?? [];
        buyPrice = quotes.length ? quotes[quotes.length - 1].close : null;
      } catch {
        buyPrice = null;
      }
    }

    if (buyPrice == null || buyPrice <= 0) {
      return {
        ok: false,
        error: `Could not fetch a live price for ${pick.ticker}.`,
      };
    }

    const position: PaperPosition = {
      id: makePositionId(pick.ticker, pick.strategyId),
      ticker: pick.ticker,
      brand: pick.brand,
      strategy: pick.strategyName,
      strategyId: pick.strategyId,
      side: sideForStrategy(pick),
      buyPrice,
      buyDate: new Date().toISOString().slice(0, 10),
      addedAt: new Date().toISOString(),
    };

    setPositions((prev) => {
      const exists = prev.some(
        (p) => p.ticker === position.ticker && p.strategyId === position.strategyId
      );
      if (exists) {
        return prev.map((p) =>
          p.ticker === position.ticker && p.strategyId === position.strategyId
            ? position
            : p
        );
      }
      return [position, ...prev];
    });

    return { ok: true };
  }, []);

  const removePosition = useCallback((id: string) => {
    setPositions((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const setAdvice = useCallback((items: PositionAdvice[]) => {
    const map: Record<string, PositionAdvice> = {};
    for (const item of items) {
      map[item.ticker.toUpperCase()] = item;
    }
    setAdviceByTicker(map);
  }, []);

  const clearAdvice = useCallback(() => setAdviceByTicker({}), []);

  const value = useMemo(
    () => ({
      positions,
      adviceByTicker,
      addFromStrategy,
      removePosition,
      setAdvice,
      clearAdvice,
    }),
    [
      positions,
      adviceByTicker,
      addFromStrategy,
      removePosition,
      setAdvice,
      clearAdvice,
    ]
  );

  return (
    <PaperPortfolioContext.Provider value={value}>
      {children}
    </PaperPortfolioContext.Provider>
  );
}

export function usePaperPortfolio(): PaperPortfolioContextValue {
  const ctx = useContext(PaperPortfolioContext);
  if (!ctx) {
    throw new Error(
      "usePaperPortfolio must be used within PaperPortfolioProvider"
    );
  }
  return ctx;
}

export default PaperPortfolioProvider;
