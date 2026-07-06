"use client";

import { useState } from "react";

import type { EntityMeta } from "@/app/actions";
import type { ChartContext } from "@/lib/chart-context";

import AiAnalyst from "./ai-analyst";
import TrendExplorer from "./trend-explorer";

export default function TerminalShell({
  entities,
}: {
  entities: EntityMeta[];
}) {
  const [chartContext, setChartContext] = useState<ChartContext | null>(null);

  return (
    <>
      <TrendExplorer
        entities={entities}
        onChartContextChange={setChartContext}
      />
      <AiAnalyst chartContext={chartContext} />
    </>
  );
}
