import { notFound } from "next/navigation";

import CompanyTerminal from "@/app/components/company-terminal";
import TerminalChrome from "@/app/components/terminal-chrome";
import {
  getParentByTicker,
  listParentCompanies,
  normalizeTickerParam,
} from "@/lib/entities";

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

export default async function CompanyPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker: raw } = await params;
  const ticker = normalizeTickerParam(raw);
  const parent = getParentByTicker(ticker);

  if (!parent) notFound();

  return (
    <div className="min-h-screen bg-neutral-950">
      <TerminalChrome subtitle={`${parent.name} · Parent Terminal`} />
      <main className="mx-auto max-w-[1600px] p-6">
        <CompanyTerminal parent={parent} />
      </main>
    </div>
  );
}
