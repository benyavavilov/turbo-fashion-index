"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  Calendar,
  Download,
  Gauge,
  Globe,
  LayoutDashboard,
  LineChart as LineChartIcon,
  Search,
  Settings,
  TrendingUp,
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Mock 6-month search-interest index for two brands.
const trendData = [
  { month: "Jan", brandA: 62, brandB: 48 },
  { month: "Feb", brandA: 59, brandB: 53 },
  { month: "Mar", brandA: 68, brandB: 57 },
  { month: "Apr", brandA: 74, brandB: 61 },
  { month: "May", brandA: 71, brandB: 69 },
  { month: "Jun", brandA: 83, brandB: 72 },
];

const BRAND_A_COLOR = "#6366f1"; // indigo
const BRAND_B_COLOR = "#10b981"; // emerald

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
    label: "Brand A Interest",
    value: "83",
    delta: "+12 pts",
    up: true,
    icon: Activity,
    hint: "peak in June",
  },
  {
    label: "Brand B Interest",
    value: "72",
    delta: "+24 pts",
    up: true,
    icon: Gauge,
    hint: "closing the gap",
  },
  {
    label: "A–B Spread",
    value: "11 pts",
    delta: "-13 pts",
    up: false,
    icon: BarChart3,
    hint: "narrowing lead",
  },
];

type TooltipEntry = { name: string; value: number; color: string };

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/95 px-3 py-2 shadow-xl backdrop-blur">
      <p className="mb-1 text-xs font-medium uppercase tracking-wider text-neutral-500">
        {label}
      </p>
      {payload.map((entry) => (
        <div
          key={entry.name}
          className="flex items-center justify-between gap-6 text-sm"
        >
          <span className="flex items-center gap-2 text-neutral-300">
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            {entry.name}
          </span>
          <span className="font-mono font-medium text-neutral-100">
            {entry.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function Home() {
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

          {/* Main chart */}
          <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-5">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-neutral-100">
                  Search Interest Over Time
                </h2>
                <p className="text-sm text-neutral-500">
                  Normalized index (0–100) · Jan – Jun
                </p>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-4 text-sm">
                  <span className="flex items-center gap-2 text-neutral-300">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: BRAND_A_COLOR }}
                    />
                    Brand A
                  </span>
                  <span className="flex items-center gap-2 text-neutral-300">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: BRAND_B_COLOR }}
                    />
                    Brand B
                  </span>
                </div>
                <button className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:bg-neutral-800">
                  <Download className="h-4 w-4" />
                  Export
                </button>
              </div>
            </div>

            <div className="h-80 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={trendData}
                  margin={{ top: 8, right: 12, left: -8, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="brandA" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={BRAND_A_COLOR} stopOpacity={0.25} />
                      <stop offset="100%" stopColor={BRAND_A_COLOR} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#262626"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="month"
                    stroke="#525252"
                    fontSize={12}
                    tickLine={false}
                    axisLine={{ stroke: "#262626" }}
                  />
                  <YAxis
                    domain={[0, 100]}
                    stroke="#525252"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    width={40}
                  />
                  <Tooltip
                    content={<ChartTooltip />}
                    cursor={{ stroke: "#404040", strokeWidth: 1 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="brandA"
                    name="Brand A"
                    stroke={BRAND_A_COLOR}
                    strokeWidth={2}
                    dot={{ r: 3, fill: BRAND_A_COLOR, strokeWidth: 0 }}
                    activeDot={{ r: 5 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="brandB"
                    name="Brand B"
                    stroke={BRAND_B_COLOR}
                    strokeWidth={2}
                    dot={{ r: 3, fill: BRAND_B_COLOR, strokeWidth: 0 }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <p className="text-center text-xs text-neutral-600">
            Mock data shown for demonstration. Live figures will be sourced from
            the Google Trends pipeline.
          </p>
        </main>
      </div>
    </div>
  );
}
