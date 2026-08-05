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

  // AI SDK v5+: status replaces legacy isLoading
  const isLoading = status === "submitted" || status === "streaming";

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isLoading) return;
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
    <div className="flex min-h-[240px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
        <MessageSquare className="h-4 w-4 text-blue-700" />
        <p className="text-sm font-semibold text-slate-900">
          Ask Gemini about ${ticker}
        </p>
      </div>

      <div className="max-h-[220px] flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {messages.length === 0 && !isLoading && (
          <p className="text-xs leading-relaxed text-slate-500">
            Ask why search spiked, what drove a drawdown, or how child-brand
            momentum maps to ${ticker}.
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`rounded-lg px-3 py-2 text-xs ${
              m.role === "user"
                ? "ml-6 bg-blue-50 text-blue-900"
                : "mr-2 border border-slate-200 bg-slate-50 text-slate-800"
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
                    className="prose prose-sm max-w-none text-xs leading-relaxed prose-p:my-1 prose-ul:my-1 prose-li:my-0 prose-headings:my-1 prose-strong:text-slate-900"
                  >
                    <ReactMarkdown>{part.text}</ReactMarkdown>
                  </div>
                )
              ) : null
            )}
          </div>
        ))}
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-slate-500 animate-pulse">
            <svg
              className="h-4 w-4 animate-spin text-blue-600"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            Gemini is analyzing...
          </div>
        )}
        {displayError && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {displayError}
          </p>
        )}
      </div>

      <form onSubmit={onSubmit} className="border-t border-slate-200 p-3">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Ask Gemini about $${ticker}…`}
            disabled={isLoading}
            className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-blue-700 focus:bg-white disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="rounded-lg bg-blue-700 px-3 py-2.5 text-white transition hover:bg-blue-800 disabled:opacity-40"
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
