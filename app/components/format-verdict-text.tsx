import type { ReactNode } from "react";

const VERDICT_TOKEN_RE = /(BEAT_LIKELY|MISS_LIKELY|PRICED_IN)/g;

const VERDICT_SPAN: Record<string, { label: string; className: string }> = {
  BEAT_LIKELY: {
    label: "Beat Likely",
    className: "font-bold text-green-600",
  },
  MISS_LIKELY: {
    label: "Miss Likely",
    className: "font-bold text-red-600",
  },
  PRICED_IN: {
    label: "Priced In",
    className: "font-bold text-amber-500",
  },
};

/**
 * Replace raw DB enums in AI verdict copy with colorized JSX spans.
 */
export function formatVerdictText(
  text: string | null | undefined,
  fallback = "No terminal verdict cached yet."
): ReactNode {
  if (!text) return fallback;

  const parts = text.split(VERDICT_TOKEN_RE);
  if (parts.length === 1) return text;

  return parts.map((part, i) => {
    const mapped = VERDICT_SPAN[part];
    if (!mapped) return part;
    return (
      <span key={`${part}-${i}`} className={mapped.className}>
        {mapped.label}
      </span>
    );
  });
}
