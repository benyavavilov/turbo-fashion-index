"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Bot, Send } from "lucide-react";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";

/**
 * Embedded home-page chat — reuses /api/chat (live Gemini stream).
 * Broader market questions; no chart pin required.
 */
export default function MarketChat() {
  const [input, setInput] = useState("");
  const [displayError, setDisplayError] = useState<string | null>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: {
          chartContext: {
            timeframe: "1Y",
            selectedEntities: [],
            showSMA: false,
            showStockOverlay: false,
            visibleChartData: [],
            observationCount: 0,
            isLive: true,
          },
        },
        fetch: async (inputUrl, init) => {
          let res: Response;
          try {
            res = await fetch(inputUrl, init);
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "Network request failed";
            throw new Error(JSON.stringify({ error: message }));
          }

          if (!res.ok) {
            const text = await res.text();
            let message = `Chat request failed (${res.status})`;
            if (text) {
              try {
                const data = JSON.parse(text) as { error?: string };
                message = data.error ?? text;
              } catch {
                message = text;
              }
            }
            throw new Error(JSON.stringify({ error: message }));
          }
          return res;
        },
      }),
    []
  );

  const { messages, sendMessage, status } = useChat({
    transport,
    onError: async (error) => {
      try {
        const serverError = JSON.parse(error.message) as { error?: string };
        setDisplayError(serverError.error || "AI Route Failure");
      } catch {
        setDisplayError(error.message);
      }
    },
  });

  const isBusy = status === "submitted" || status === "streaming";

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isBusy) return;
    setInput("");
    setDisplayError(null);
    try {
      await sendMessage({ text });
    } catch (error) {
      if (error instanceof Error) {
        try {
          const serverError = JSON.parse(error.message) as { error?: string };
          setDisplayError(serverError.error || "AI Route Failure");
        } catch {
          setDisplayError(error.message);
        }
      } else {
        setDisplayError("AI Route Failure");
      }
    }
  };

  return (
    <section className="flex h-full min-h-[420px] flex-col overflow-hidden rounded-xl border border-neutral-800/80 bg-gradient-to-b from-neutral-900/80 via-neutral-950 to-neutral-950">
      <header className="flex items-center gap-3 border-b border-neutral-800/80 px-5 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/15 ring-1 ring-indigo-500/30">
          <Bot className="h-4 w-4 text-indigo-300" />
        </div>
        <div>
          <p className="text-sm font-semibold text-neutral-100">
            Market Desk Chat
          </p>
          <p className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">
            Ask Gemini about the broader market…
          </p>
        </div>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="rounded-lg border border-neutral-800/80 bg-neutral-900/40 p-4 text-sm leading-relaxed text-neutral-400">
            Ask about sector rotation, search-led demand shifts across fashion
            parents, or how Google Trends momentum might map to equities this
            week. Live stream via Gemini — Alpha Feed cards stay pre-computed.
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`rounded-lg px-3 py-2 text-sm ${
              m.role === "user"
                ? "ml-6 bg-indigo-500/15 text-indigo-100"
                : "mr-2 border border-neutral-800 bg-neutral-900/60 text-neutral-200"
            }`}
          >
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
              {m.role === "user" ? "You" : "Lead Analyst"}
            </p>
            {m.parts.map((part, i) =>
              part.type === "text" ? (
                m.role === "user" ? (
                  <p key={i} className="whitespace-pre-wrap leading-relaxed">
                    {part.text}
                  </p>
                ) : (
                  <div
                    key={i}
                    className="prose prose-invert prose-sm max-w-none leading-relaxed prose-p:my-2 prose-ul:my-2 prose-li:my-0.5 prose-headings:my-2 prose-strong:text-neutral-100"
                  >
                    <ReactMarkdown>{part.text}</ReactMarkdown>
                  </div>
                )
              ) : null
            )}
          </div>
        ))}
        {displayError && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {displayError}
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className="border-t border-neutral-800 p-4">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask Gemini about the broader market…"
            className="flex-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-indigo-500/50"
          />
          <button
            type="submit"
            disabled={isBusy || !input.trim()}
            className="rounded-lg bg-indigo-600 px-3 py-2.5 text-white transition hover:bg-indigo-500 disabled:opacity-40"
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </form>
    </section>
  );
}
