"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { MessageSquare, Send } from "lucide-react";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";

import type { ChartContext } from "@/lib/chart-context";

export default function CompanyChat({
  chartContext,
  ticker,
}: {
  chartContext: ChartContext | null;
  ticker: string;
}) {
  const [input, setInput] = useState("");
  const [displayError, setDisplayError] = useState<string | null>(null);

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
    <div className="mt-5 flex min-h-[280px] flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/60">
      <div className="flex items-center gap-2 border-b border-neutral-800/80 px-3 py-2">
        <MessageSquare className="h-3.5 w-3.5 text-indigo-400" />
        <p className="text-[11px] font-semibold tracking-tight text-neutral-300">
          Ask Gemini about ${ticker}
        </p>
      </div>

      <div className="max-h-[220px] flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <p className="text-[11px] leading-relaxed text-neutral-600">
            Ask why search spiked, what drove a drawdown, or how child-brand
            momentum maps to ${ticker}. Context includes this parent page and
            any catalyst briefings from Analyze.
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`rounded-md px-2.5 py-1.5 text-[11px] ${
              m.role === "user"
                ? "ml-4 bg-indigo-500/15 text-indigo-100"
                : "mr-2 border border-neutral-800 bg-neutral-900/70 text-neutral-300"
            }`}
          >
            {m.parts.map((part, i) =>
              part.type === "text" ? (
                m.role === "user" ? (
                  <p key={i} className="whitespace-pre-wrap leading-relaxed">
                    {part.text}
                  </p>
                ) : (
                  <div
                    key={i}
                    className="prose prose-invert prose-sm max-w-none text-[11px] leading-relaxed prose-p:my-1 prose-ul:my-1 prose-li:my-0 prose-headings:my-1 prose-strong:text-neutral-100"
                  >
                    <ReactMarkdown>{part.text}</ReactMarkdown>
                  </div>
                )
              ) : null
            )}
          </div>
        ))}
        {displayError && (
          <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-300">
            {displayError}
          </p>
        )}
      </div>

      <form
        onSubmit={onSubmit}
        className="border-t border-neutral-800/80 p-2"
      >
        <div className="flex gap-1.5">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Ask Gemini about $${ticker}…`}
            className="min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-900/80 px-2.5 py-1.5 text-[11px] text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-indigo-500/40"
          />
          <button
            type="submit"
            disabled={isBusy || !input.trim()}
            className="rounded-md bg-indigo-600 px-2.5 py-1.5 text-white transition hover:bg-indigo-500 disabled:opacity-40"
            aria-label="Send"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </form>
    </div>
  );
}
