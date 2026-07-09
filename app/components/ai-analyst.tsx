"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Bot, MessageSquare, Send, X } from "lucide-react";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";

import type { ChartContext } from "@/lib/chart-context";
import { normalizeDateString } from "@/lib/chart-data";

export default function AiAnalyst({
  chartContext,
}: {
  chartContext: ChartContext | null;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [displayError, setDisplayError] = useState<string | null>(null);

  // DefaultChatTransport sends the full messages[] history on every turn
  // alongside the latest chartContext snapshot (full visible dataset).
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: { chartContext },
        fetch: async (input, init) => {
          let res: Response;
          try {
            res = await fetch(input, init);
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
    [chartContext]
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
      console.error("[AI Analyst]", error);
    },
  });

  const isBusy = status === "submitted" || status === "streaming";

  const contextSummary = useMemo(() => {
    if (!chartContext) return null;
    const pin = chartContext.pinnedData
      ? ` · pinned ${normalizeDateString(chartContext.pinnedData.date)}`
      : "";
    return `${chartContext.selectedEntities.join(", ") || "no entities"} · ${chartContext.timeframe} · ${chartContext.observationCount} pts${pin}`;
  }, [chartContext]);

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
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-600 px-4 py-3 text-sm font-medium text-white shadow-[0_0_24px_rgba(99,102,241,0.35)] transition hover:bg-indigo-500"
        >
          <Bot className="h-5 w-5" />
          AI Analyst
        </button>
      )}

      {open && (
        <aside className="fixed bottom-0 right-0 top-0 z-50 flex w-full max-w-md flex-col border-l border-neutral-800 bg-neutral-950/95 shadow-2xl backdrop-blur-xl">
          <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/20">
                <MessageSquare className="h-4 w-4 text-indigo-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-neutral-100">
                  TurboFashion Lead Analyst
                </p>
                <p className="text-[10px] uppercase tracking-widest text-neutral-500">
                  {contextSummary ?? "Awaiting chart context"}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md p-2 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {messages.length === 0 && (
              <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 text-sm text-neutral-400">
                Ask about momentum shifts, brand vs. trend dynamics, or whether search
                interest is leading equity moves. I see the{" "}
                <strong className="text-neutral-300">full visible chart history</strong>
                {chartContext
                  ? ` (${chartContext.observationCount} observations).`
                  : " once entities are selected."}
              </div>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={`rounded-lg px-3 py-2 text-sm ${
                  m.role === "user"
                    ? "ml-8 bg-indigo-500/15 text-indigo-100"
                    : "mr-4 border border-neutral-800 bg-neutral-900/60 text-neutral-200"
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
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-rose-400/80">
                  Error
                </p>
                <p className="whitespace-pre-wrap break-words leading-relaxed">
                  {displayError}
                </p>
              </div>
            )}
          </div>

          <form
            onSubmit={onSubmit}
            className="border-t border-neutral-800 p-4"
          >
            <div className="flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about the chart…"
                className="flex-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-indigo-500/50"
              />
              <button
                type="submit"
                disabled={isBusy || !input.trim()}
                className="rounded-lg bg-indigo-600 px-3 py-2 text-white transition hover:bg-indigo-500 disabled:opacity-40"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </form>
        </aside>
      )}
    </>
  );
}
