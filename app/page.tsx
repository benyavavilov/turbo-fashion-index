import { Activity, BarChart3, Gauge, LineChart as LineChartIcon, TrendingUp } from "lucide-react";

import { getTrackedEntities } from "./actions";
import TerminalShell from "./components/terminal-shell";

export const dynamic = "force-dynamic";

const kpis = [
  {
    label: "Index Momentum",
    value: "83.0",
    delta: "+16.9%",
    up: true,
    icon: TrendingUp,
    hint: "vs. 6-month start",
  },
  {
    label: "Tracked Entities",
    value: "30",
    delta: "brands + trends",
    up: true,
    icon: Activity,
    hint: "live from Supabase",
  },
  {
    label: "Top Mover",
    value: "Quiet Luxury",
    delta: "+41 pts",
    up: true,
    icon: Gauge,
    hint: "fastest riser",
  },
  {
    label: "Data Coverage",
    value: "5 yr",
    delta: "weekly",
    up: true,
    icon: BarChart3,
    hint: "rolling window",
  },
];

export default async function Home() {
  const entities = await getTrackedEntities();

  return (
    <div className="min-h-screen bg-neutral-950">
      <header className="border-b border-neutral-800/80 bg-neutral-950/80 px-6 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/15 ring-1 ring-inset ring-indigo-500/30">
              <LineChartIcon className="h-4 w-4 text-indigo-400" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-neutral-100">
                TurboFashion Index
              </h1>
              <p className="text-xs text-neutral-500">
                AI-powered fashion search intelligence terminal
              </p>
            </div>
          </div>
          <div className="hidden items-center gap-2 md:flex">
            <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-emerald-400 ring-1 ring-inset ring-emerald-500/25">
              Live
            </span>
            <span className="text-[11px] text-neutral-600">
              Google Trends · Supabase · Yahoo Finance
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] space-y-6 p-6">
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {kpis.map(({ label, value, delta, up, icon: Icon, hint }) => (
            <div
              key={label}
              className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-4"
            >
              <div className="flex items-start justify-between">
                <span className="text-sm text-neutral-400">{label}</span>
                <Icon className="h-4 w-4 text-neutral-600" />
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="font-mono text-2xl font-semibold tracking-tight text-neutral-100">
                  {value}
                </span>
                <span
                  className={`text-xs font-medium ${
                    up ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {delta}
                </span>
              </div>
              <p className="mt-1 text-xs text-neutral-500">{hint}</p>
            </div>
          ))}
        </section>

        <TerminalShell entities={entities} />

        <p className="text-center text-xs text-neutral-600">
          Search interest from Google Trends · stored in Supabase · equity overlay via
          Yahoo Finance · analysis powered by AI
        </p>
      </main>
    </div>
  );
}
