import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  Calendar,
  Gauge,
  Globe,
  LayoutDashboard,
  LineChart as LineChartIcon,
  Search,
  Settings,
  TrendingUp,
} from "lucide-react";

import { getTrendData } from "./actions";
import TrendExplorer from "./components/trend-explorer";

// Always render at request time so the dashboard reflects live Supabase data.
export const dynamic = "force-dynamic";

const navItems = [
  { icon: LayoutDashboard, label: "Overview", active: true },
  { icon: LineChartIcon, label: "Trends" },
  { icon: BarChart3, label: "Comparisons" },
  { icon: Globe, label: "Regions" },
  { icon: Settings, label: "Settings" },
];

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
    value: "20",
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
    value: "6 mo",
    delta: "weekly",
    up: true,
    icon: BarChart3,
    hint: "rolling window",
  },
];

export default async function Home() {
  const { data, entities } = await getTrendData();

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-neutral-800/80 bg-neutral-950 px-4 py-6 lg:flex">
        <div className="mb-8 flex items-center gap-2 px-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-indigo-500/15 ring-1 ring-inset ring-indigo-500/30">
            <LineChartIcon className="h-4 w-4 text-indigo-400" />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-semibold text-neutral-100">TurboFashion</p>
            <p className="text-[11px] uppercase tracking-widest text-neutral-500">
              Index
            </p>
          </div>
        </div>

        <nav className="flex flex-col gap-1">
          {navItems.map(({ icon: Icon, label, active }) => (
            <a
              key={label}
              href="#"
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                active
                  ? "bg-neutral-800/70 text-neutral-100"
                  : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </a>
          ))}
        </nav>

        <div className="mt-auto rounded-lg border border-neutral-800/80 bg-neutral-900/40 p-3">
          <p className="text-xs font-medium text-neutral-300">Data pipeline</p>
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-neutral-500">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Google Trends · idle
          </p>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="flex items-center justify-between gap-4 border-b border-neutral-800/80 px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-neutral-100">
              Fashion Search Index
            </h1>
            <p className="text-sm text-neutral-500">
              Relative search interest across tracked brands
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-1.5 text-sm text-neutral-500 md:flex">
              <Search className="h-4 w-4" />
              <span>Search brands…</span>
            </div>
            <button className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:bg-neutral-800">
              <Calendar className="h-4 w-4" />
              Last 6 months
            </button>
            <button className="rounded-md border border-neutral-800 bg-neutral-900/60 p-2 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200">
              <Bell className="h-4 w-4" />
            </button>
          </div>
        </header>

        <main className="flex-1 space-y-6 p-6">
          {/* KPI cards */}
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
                    className={`flex items-center gap-0.5 text-xs font-medium ${
                      up ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    {up ? (
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    ) : (
                      <ArrowDownRight className="h-3.5 w-3.5" />
                    )}
                    {delta}
                  </span>
                </div>
                <p className="mt-1 text-xs text-neutral-500">{hint}</p>
              </div>
            ))}
          </section>

          {/* Live, interactive trend explorer (Client Component) */}
          <TrendExplorer data={data} entities={entities} />

          <p className="text-center text-xs text-neutral-600">
            Search interest sourced from the Google Trends pipeline and stored in
            Supabase. Toggle between brands and cultural trends above.
          </p>
        </main>
      </div>
    </div>
  );
}
