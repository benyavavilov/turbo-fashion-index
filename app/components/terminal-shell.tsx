"use client";

import { useState } from "react";

import type { EntityMeta } from "@/lib/entities";
import type { ChartContext } from "@/lib/chart-context";

import AiAnalyst from "./ai-analyst";
import TrendExplorer from "./trend-explorer";

export default function TerminalShell({
  entities,
  isLive,
}: {
  entities: EntityMeta[];
  isLive: boolean;
}) {
  const [chartContext, setChartContext] = useState<ChartContext | null>(null);

  return (
    <>
      <TrendExplorer
        entities={entities}
        isLive={isLive}
        onChartContextChange={setChartContext}
      />
      <AiAnalyst chartContext={chartContext} />
    </>
  );
}
