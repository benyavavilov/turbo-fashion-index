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
    <section className="flex h-full min-h-[420px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-center gap-3 border-b border-slate-200 px-5 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-700 text-white">
          <Bot className="h-4 w-4" />
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-900">
            Market Desk Chat
          </p>
          <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
            Ask Gemini about the broader market…
          </p>
        </div>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-600">
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
                ? "ml-6 bg-blue-50 text-blue-900"
                : "mr-2 border border-slate-200 bg-slate-50 text-slate-800"
            }`}
          >
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
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
                    className="prose prose-sm max-w-none leading-relaxed prose-p:my-2 prose-ul:my-2 prose-li:my-0.5 prose-headings:my-2 prose-strong:text-slate-900"
                  >
                    <ReactMarkdown>{part.text}</ReactMarkdown>
                  </div>
                )
              ) : null
            )}
          </div>
        ))}
        {displayError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {displayError}
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className="border-t border-slate-200 p-4">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask Gemini about the broader market…"
            className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={isBusy || !input.trim()}
            className="rounded-lg bg-blue-700 px-3 py-2.5 text-white transition hover:bg-blue-800 disabled:opacity-40"
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </form>
    </section>
  );
}
