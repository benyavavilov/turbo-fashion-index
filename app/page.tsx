import AlphaFeed from "@/app/components/alpha-feed";
import TerminalChrome from "@/app/components/terminal-chrome";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <div className="min-h-screen bg-slate-50">
      <TerminalChrome subtitle="Earnings Whisper Terminal" />

      <main className="mx-auto max-w-[1200px] space-y-8 p-6">
        <AlphaFeed />
      </main>
    </div>
  );
}
