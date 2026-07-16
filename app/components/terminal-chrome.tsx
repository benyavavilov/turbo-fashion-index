import Link from "next/link";
import { LineChart as LineChartIcon } from "lucide-react";

export default function TerminalChrome({
  subtitle = "Curated Intelligence Terminal",
  right,
}: {
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <header className="border-b border-neutral-800/80 bg-neutral-950/80 px-6 py-4 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-3 transition hover:opacity-90"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/15 ring-1 ring-inset ring-indigo-500/30">
              <LineChartIcon className="h-4 w-4 text-indigo-400" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-neutral-100">
                Turbo Fashion Index
              </h1>
              <p className="text-xs text-neutral-500">{subtitle}</p>
            </div>
          </Link>
        </div>
        <div className="flex items-center gap-3">
          {right}
          <div className="hidden items-center gap-2 md:flex">
            <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-emerald-400 ring-1 ring-inset ring-emerald-500/25">
              Live
            </span>
            <span className="text-[11px] text-neutral-600">
              Parents · Child Brands · Yahoo · Gemini
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}
