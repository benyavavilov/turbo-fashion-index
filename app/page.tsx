import Link from "next/link";

import AlphaFeed from "@/app/components/alpha-feed";
import TerminalChrome from "@/app/components/terminal-chrome";
import { listParentCompanies } from "@/lib/entities";

export const dynamic = "force-dynamic";

export default function Home() {
  const parents = listParentCompanies();

  return (
    <div className="min-h-screen bg-neutral-950">
      <TerminalChrome subtitle="Curated Intelligence Terminal · V3" />

      <main className="mx-auto max-w-[1600px] space-y-8 p-6">
        <AlphaFeed />

        <section className="rounded-xl border border-neutral-800/60 bg-neutral-900/30 p-5">
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-500">
            Parent universe
          </p>
          <div className="flex flex-wrap gap-2">
            {parents.map((p) => (
              <Link
                key={p.ticker}
                href={`/company/${encodeURIComponent(p.ticker)}`}
                className="rounded-full border border-neutral-800 bg-neutral-950/60 px-3 py-1.5 text-xs text-neutral-400 transition hover:border-indigo-500/40 hover:text-neutral-200"
              >
                {p.name}{" "}
                <span className="font-mono text-indigo-300/80">${p.ticker}</span>
              </Link>
            ))}
          </div>
        </section>

        <p className="text-center text-xs text-neutral-600">
          Parent companies · child brand search interest · event-study alpha ·
          Gemini catalysts
        </p>
      </main>
    </div>
  );
}
