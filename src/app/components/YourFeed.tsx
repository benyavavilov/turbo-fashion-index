"use client";

import { useEffect, useMemo, useState } from "react";
import {
  fetchNewsForSlugs,
  type BrandNewsItem,
  type BrandRecord,
} from "@/app/lib/search-config";
import {
  CATEGORY_DEFS,
  categoryToPreferenceKey,
  formatRelativeTime,
  readSubscriptions,
  type PreferenceKey,
  type SubscriptionMap,
} from "@/app/lib/subscriptions";

export interface YourFeedProps {
  brands: BrandRecord[];
}

type BrandFilterState = Record<string, boolean>;
type CategoryFilterState = Record<PreferenceKey, boolean>;

const ALL_CATEGORIES_ON: CategoryFilterState = {
  drops: true,
  restocks: true,
  sales: true,
};

export default function YourFeed({ brands }: YourFeedProps) {
  const [hydrated, setHydrated] = useState(false);
  const [subscriptions, setSubscriptions] = useState<SubscriptionMap>({});
  const [news, setNews] = useState<BrandNewsItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeBrands, setActiveBrands] = useState<BrandFilterState>({});
  const [activeCategories, setActiveCategories] =
    useState<CategoryFilterState>(ALL_CATEGORIES_ON);

  const nameBySlug = useMemo(() => {
    const map = new Map<string, string>();
    for (const brand of brands) {
      map.set(brand.slug, brand.name);
    }
    return map;
  }, [brands]);

  const subscribedSlugs = useMemo(
    () =>
      Object.entries(subscriptions)
        .filter(([, sub]) => sub.isSubscribed)
        .map(([slug]) => slug),
    [subscriptions],
  );

  // Read localStorage only after mount to avoid hydration mismatches.
  useEffect(() => {
    const stored = readSubscriptions();
    setSubscriptions(stored);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    setActiveBrands((prev) => {
      const next: BrandFilterState = {};
      for (const slug of subscribedSlugs) {
        next[slug] = prev[slug] ?? true;
      }
      return next;
    });

    if (subscribedSlugs.length === 0) {
      setNews([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    fetchNewsForSlugs(subscribedSlugs)
      .then((items) => {
        if (!cancelled) {
          setNews(items);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hydrated, subscribedSlugs]);

  const visibleItems = useMemo(() => {
    return news.filter((item) => {
      if (!activeBrands[item.brand_slug]) {
        return false;
      }

      const prefKey = categoryToPreferenceKey(item.category);
      if (prefKey === null) {
        return true; // "General" items are always shown.
      }

      if (!activeCategories[prefKey]) {
        return false;
      }

      const brandPrefs = subscriptions[item.brand_slug]?.preferences;
      return brandPrefs ? brandPrefs[prefKey] : true;
    });
  }, [news, activeBrands, activeCategories, subscriptions]);

  const toggleBrand = (slug: string) => {
    setActiveBrands((prev) => ({ ...prev, [slug]: !prev[slug] }));
  };

  const toggleCategory = (key: PreferenceKey) => {
    setActiveCategories((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  if (!hydrated) {
    return null;
  }

  return (
    <section className="mt-16 w-full">
      <h2 className="mb-5 text-sm font-semibold uppercase tracking-[0.25em] text-zinc-400">
        Your Feed
      </h2>

      {subscribedSlugs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/60 px-6 py-16 text-center">
          <p className="mx-auto max-w-md text-sm leading-7 text-zinc-500">
            Your feed is empty. Search for your favorite brands above and
            subscribe to customize your drops radar!
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-4 rounded-2xl border border-zinc-800 bg-zinc-950 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-2">
              {subscribedSlugs.map((slug) => {
                const active = Boolean(activeBrands[slug]);
                return (
                  <button
                    key={slug}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleBrand(slug)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                      active
                        ? "border-zinc-100 bg-zinc-100 text-black"
                        : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                    }`}
                  >
                    {nameBySlug.get(slug) ?? slug}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap gap-2">
              {CATEGORY_DEFS.map((def) => {
                const active = activeCategories[def.key];
                return (
                  <button
                    key={def.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleCategory(def.key)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                      active
                        ? "border-zinc-100 bg-zinc-100 text-black"
                        : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                    }`}
                  >
                    {def.shortLabel}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-5">
            {loading ? (
              <p className="py-10 text-center text-sm text-zinc-600">
                Loading your drops radar…
              </p>
            ) : visibleItems.length === 0 ? (
              <p className="py-10 text-center text-sm text-zinc-600">
                No updates match your current filters.
              </p>
            ) : (
              <ul className="space-y-3">
                {visibleItems.map((item) => (
                  <FeedItem
                    key={item.id}
                    item={item}
                    brandName={nameBySlug.get(item.brand_slug) ?? item.brand_slug}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function FeedItem({
  item,
  brandName,
}: {
  item: BrandNewsItem;
  brandName: string;
}) {
  return (
    <li>
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-4 rounded-xl border border-zinc-900 bg-zinc-950 p-4 transition-colors hover:border-zinc-700 hover:bg-zinc-900"
      >
        {item.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.image_url}
            alt=""
            className="h-16 w-16 shrink-0 rounded-lg object-cover"
          />
        ) : (
          <div className="h-16 w-16 shrink-0 rounded-lg bg-zinc-800" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
              {brandName}
            </span>
            <span className="text-zinc-700">·</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">
              {item.category}
            </span>
          </div>
          <p className="mt-1 truncate text-sm font-medium text-zinc-100">
            {item.notification_banner || item.title}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            {formatRelativeTime(item.published_at)}
          </p>
        </div>
      </a>
    </li>
  );
}
