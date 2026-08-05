import { notFound } from "next/navigation";
import YahooFinance from "yahoo-finance2";

import CompanyTerminal, {
  type CompanyNewsArticle,
} from "@/app/components/company-terminal";
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

/** Lean Earnings Whisper columns from ai_insights. */
const ASSET_PROFILE_SELECT = [
  "ticker",
  "parent_name",
  "brand",
  "earnings_mismatch",
  "expected_revenue_growth",
  "momentum_pct",
  "terminal_verdict",
].join(",");

const yahooFinance = new YahooFinance();

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
    description: `Earnings Whisper profile for ${parent.name}: search vs Street revenue estimates, and live catalyst briefing.`,
  };
}

async function loadCachedInsight(ticker: string): Promise<CompanyBrief | null> {
  const supabase = createBrowserSupabase();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("ai_insights")
    .select(ASSET_PROFILE_SELECT)
    .eq("ticker", ticker);

  if (error || !data?.length) return null;
  return selectBriefForTicker(data as unknown as AiInsightRow[], ticker);
}

async function loadRecentNews(ticker: string): Promise<CompanyNewsArticle[]> {
  try {
    const searchResult = await yahooFinance.search(ticker);
    const newsArticles = searchResult.news?.slice(0, 3) || [];
    return newsArticles.map((article) => ({
      uuid: String(article.uuid ?? article.link ?? article.title ?? ""),
      title: String(article.title ?? "Untitled"),
      publisher: String(article.publisher ?? "Yahoo Finance"),
      link: String(article.link ?? "#"),
      providerPublishTime: article.providerPublishTime ?? null,
    }));
  } catch (error) {
    console.warn(`[company/${ticker}] news fetch failed:`, error);
    return [];
  }
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

  const [insight, newsArticles] = await Promise.all([
    loadCachedInsight(ticker),
    loadRecentNews(ticker),
  ]);

  return (
    <div className="min-h-screen bg-slate-50">
      <TerminalChrome subtitle={`${parent.name} · Earnings Whisper`} />
      <main className="mx-auto max-w-[1600px] p-6">
        <CompanyTerminal
          parent={parent}
          initialInsight={insight}
          newsArticles={newsArticles}
        />
      </main>
    </div>
  );
}
