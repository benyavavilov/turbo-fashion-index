import { LineChart as LineChartIcon } from "lucide-react";

import { getTrackedEntities } from "./actions";
import { isSupabaseConfigured } from "@/lib/supabase";
import TerminalShell from "./components/terminal-shell";

export const dynamic = "force-dynamic";

export default async function Home() {
  const entities = await getTrackedEntities();
  const isLive = isSupabaseConfigured();

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
                Turbo Fashion Index
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
        <TerminalShell entities={entities} isLive={isLive} />

        <p className="text-center text-xs text-neutral-600">
          Search interest from Google Trends · stored in Supabase · equity overlay via
          Yahoo Finance · analysis powered by AI
        </p>
      </main>
    </div>
  );
}
