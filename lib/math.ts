/**
 * Pearson product-moment correlation coefficient.
 * Returns a value in [-1, 1], or 0 when undefined (e.g. insufficient paired data).
 */
export function calculatePearson(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) return 0;

  const n = x.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt(
    (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY)
  );

  if (denominator === 0) return 0;

  const r = numerator / denominator;
  return Math.max(-1, Math.min(1, r));
}

export function formatCorrelationLabel(r: number): string {
  const formatted = r >= 0 ? `+${r.toFixed(2)}` : r.toFixed(2);
  if (r > 0.7) return `Correlation: ${formatted} (Strong)`;
  if (r >= 0.3) return `Correlation: ${formatted} (Moderate)`;
  return `Correlation: ${formatted} (Weak/Inverse)`;
}

export function correlationBadgeClass(r: number): string {
  if (r > 0.7) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  }
  if (r >= 0.3) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-300";
  }
  return "border-neutral-600/40 bg-neutral-800/60 text-neutral-400";
}
