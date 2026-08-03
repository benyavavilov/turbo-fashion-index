"use client";

import Link from "next/link";
import { useState } from "react";
import { LineChart as LineChartIcon } from "lucide-react";

import FeedbackModal from "@/app/components/feedback-modal";

export default function TerminalChrome({
  subtitle = "Institutional Intelligence Terminal",
  right,
}: {
  subtitle?: string;
  right?: React.ReactNode;
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  return (
    <>
      <header className="border-b border-slate-200 bg-white/90 px-6 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="flex items-center gap-3 transition hover:opacity-90"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-700 text-white shadow-sm">
                <LineChartIcon className="h-4 w-4" />
              </div>
              <div>
                <h1 className="text-lg font-semibold tracking-tight text-slate-900">
                  Turbo Fashion Index
                </h1>
                <p className="text-xs text-slate-500">{subtitle}</p>
              </div>
            </Link>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <nav className="flex items-center gap-1 sm:gap-2">
              <Link
                href="/"
                className="rounded-md px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 sm:text-sm"
              >
                Feed
              </Link>
              <Link
                href="/about"
                className="rounded-md px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 sm:text-sm"
              >
                About
              </Link>
              <button
                type="button"
                onClick={() => setFeedbackOpen(true)}
                className="rounded-md px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 sm:text-sm"
              >
                Feedback
              </button>
            </nav>
            {right}
            <div className="hidden items-center gap-2 lg:flex">
              <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-blue-800 ring-1 ring-inset ring-blue-200">
                Live
              </span>
            </div>
          </div>
        </div>
      </header>
      <FeedbackModal
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
      />
    </>
  );
}
