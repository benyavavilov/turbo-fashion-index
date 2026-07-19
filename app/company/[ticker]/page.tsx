import { notFound } from "next/navigation";

import CompanyTerminal from "@/app/components/company-terminal";
import TerminalChrome from "@/app/components/terminal-chrome";
import {
  selectBriefForTicker,
  type AiInsightRow,
  type CompanyBrief,
} from "@/lib/ai-insights";
import {
  getParentByTicker,
  listParentCompanies,
  normalizeTickerParam,
} from "@/lib/entities";
import { createBrowserSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return listParentCompanies().map((p) => ({
    ticker: p.ticker,
  }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = await params;
  const parent = getParentByTicker(normalizeTickerParam(ticker));
  if (!parent) return { title: "Company — Turbo Fashion Index" };
  return {
    title: `${parent.name} ($${parent.ticker}) — Turbo Fashion Index`,
    description: `Intelligence terminal for ${parent.name}: child brand search trends vs parent equity.`,
  };
}

async function loadCachedInsight(ticker: string): Promise<CompanyBrief | null> {
  const supabase = createBrowserSupabase();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("ai_insights")
    .select("*")
    .eq("ticker", ticker);

  if (error || !data?.length) return null;
  return selectBriefForTicker(data as AiInsightRow[], ticker);
}

export default async function CompanyPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker: raw } = await params;
  const ticker = normalizeTickerParam(raw);
  const parent = getParentByTicker(ticker);

  if (!parent) notFound();

  const insight = await loadCachedInsight(ticker);

  return (
    <div className="min-h-screen bg-neutral-950">
      <TerminalChrome subtitle={`${parent.name} · Parent Terminal`} />
      <main className="mx-auto max-w-[1600px] p-6">
        <CompanyTerminal parent={parent} initialInsight={insight} />
      </main>
    </div>
  );
}
