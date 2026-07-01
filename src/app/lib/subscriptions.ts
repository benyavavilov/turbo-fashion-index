export const SUBSCRIPTIONS_KEY = "turbo_subscriptions";

export type PreferenceKey = "drops" | "restocks" | "sales";

export interface BrandPreferences {
  drops: boolean;
  restocks: boolean;
  sales: boolean;
}

export interface BrandSubscription {
  isSubscribed: boolean;
  preferences: BrandPreferences;
}

export type SubscriptionMap = Record<string, BrandSubscription>;

export interface CategoryDef {
  key: PreferenceKey;
  /** Value stored in brand_news.category. */
  category: string;
  /** Full label used on the brand detail page. */
  label: string;
  /** Compact label used in the global feed controls. */
  shortLabel: string;
}

export const CATEGORY_DEFS: readonly CategoryDef[] = [
  {
    key: "drops",
    category: "New Product Drops & Collections",
    label: "New Product Drops & Collections",
    shortLabel: "New Drops",
  },
  {
    key: "restocks",
    category: "Restock Alerts",
    label: "Restock Alerts",
    shortLabel: "Restocks",
  },
  {
    key: "sales",
    category: "Deals & Promos",
    label: "Deals & Promos",
    shortLabel: "Deals & Promos",
  },
] as const;

export function defaultPreferences(): BrandPreferences {
  return { drops: true, restocks: true, sales: true };
}

export function defaultSubscription(): BrandSubscription {
  return { isSubscribed: false, preferences: defaultPreferences() };
}

/** Maps a brand_news category string to its preference key, or null if it maps to none. */
export function categoryToPreferenceKey(category: string): PreferenceKey | null {
  const match = CATEGORY_DEFS.find((def) => def.category === category);
  return match ? match.key : null;
}

function isPreferences(value: unknown): value is BrandPreferences {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.drops === "boolean" &&
    typeof record.restocks === "boolean" &&
    typeof record.sales === "boolean"
  );
}

function normalizeSubscription(value: unknown): BrandSubscription | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const preferences = isPreferences(record.preferences)
    ? record.preferences
    : defaultPreferences();

  return {
    isSubscribed: record.isSubscribed === true,
    preferences,
  };
}

export function readSubscriptions(): SubscriptionMap {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(SUBSCRIPTIONS_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const result: SubscriptionMap = {};
    for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
      const normalized = normalizeSubscription(value);
      if (normalized) {
        result[slug] = normalized;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function writeSubscriptions(map: SubscriptionMap): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(SUBSCRIPTIONS_KEY, JSON.stringify(map));
  } catch {
    // Storage may be unavailable (private mode / quota) — fail silently.
  }
}

export function formatRelativeTime(iso: string): string {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) {
    return "";
  }

  const diffMs = Date.now() - timestamp;
  const diffSec = Math.round(diffMs / 1000);
  const abs = Math.abs(diffSec);

  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "second"],
    [3600, "minute"],
    [86400, "hour"],
    [604800, "day"],
    [2629800, "week"],
    [31557600, "month"],
    [Infinity, "year"],
  ];

  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  let divisor = 1;
  let unit: Intl.RelativeTimeFormatUnit = "second";

  for (let i = 0; i < units.length; i++) {
    const [limit, unitName] = units[i]!;
    if (abs < limit) {
      unit = unitName;
      divisor = i === 0 ? 1 : units[i - 1]![0];
      break;
    }
  }

  return formatter.format(-Math.round(diffSec / divisor), unit);
}
