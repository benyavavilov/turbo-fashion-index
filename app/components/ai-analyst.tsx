"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Bot, MessageSquare, Send, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { ChartContext } from "@/lib/chart-context";

export default function AiAnalyst({
  chartContext,
}: {
  chartContext: ChartContext | null;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: { chartContext },
      }),
    [chartContext]
  );

  const { messages, sendMessage, status, error } = useChat({ transport });

  const isBusy = status === "submitted" || status === "streaming";

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isBusy) return;
    setInput("");
    await sendMessage({ text });
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
                <p className="text-sm font-semibold text-neutral-100">AI Economic Analyst</p>
                <p className="text-[10px] uppercase tracking-widest text-neutral-500">
                  Context-aware · Live terminal
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
                Ask about brand momentum, substitution ratios, or whether search interest
                is leading equity moves for the entities on your chart.
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
                  {m.role === "user" ? "You" : "Analyst"}
                </p>
                {m.parts.map((part, i) =>
                  part.type === "text" ? (
                    <p key={i} className="whitespace-pre-wrap leading-relaxed">
                      {part.text}
                    </p>
                  ) : null
                )}
              </div>
            ))}
            {error && (
              <p className="text-xs text-rose-400">{error.message}</p>
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
