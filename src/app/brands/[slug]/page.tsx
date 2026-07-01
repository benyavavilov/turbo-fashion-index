import Link from "next/link";
import { notFound } from "next/navigation";
import BrandThumbnail from "@/app/components/BrandThumbnail";
import SubscriptionSettings from "@/app/components/SubscriptionSettings";
import {
  fetchBrandBySlug,
  fetchBrandNewsBySlug,
  type BrandNewsItem,
} from "@/app/lib/search-config";
import { formatRelativeTime } from "@/app/lib/subscriptions";

export const dynamic = "force-dynamic";

interface BrandPageProps {
  params: Promise<{ slug: string }>;
}

export default async function BrandPage({ params }: BrandPageProps) {
  const { slug } = await params;
  const resolvedSlug = decodeURIComponent(slug);
  const brand = await fetchBrandBySlug(resolvedSlug);

  if (!brand) {
    notFound();
  }

  const news = await fetchBrandNewsBySlug(brand.slug);

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
        >
          <BackArrow />
          Back to Search
        </Link>

        <header className="mt-10 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-zinc-600">
              Brand Index
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-zinc-50 sm:text-5xl">
              {brand.name}
            </h1>
          </div>

          <HypeBadge score={brand.ai_trend_score} />
        </header>

        {brand.summary ? (
          <p className="mt-8 text-xl font-light leading-relaxed text-zinc-300">
            {brand.summary}
          </p>
        ) : (
          <p className="mt-8 text-xl font-light leading-relaxed text-zinc-600">
            No summary available yet.
          </p>
        )}

        <section className="mt-14">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-400">
                Latest Brand News &amp; Drops
              </h2>
              {news.length === 0 && (
                <span className="rounded-full border border-zinc-800 px-2.5 py-1 text-[10px] uppercase tracking-widest text-zinc-600">
                  Coming soon
                </span>
              )}
            </div>

            {news.length > 0 ? (
              <ul className="mt-5 space-y-3">
                {news.map((item) => (
                  <NewsRow key={item.id} item={item} />
                ))}
              </ul>
            ) : (
              <ul className="mt-5 space-y-3">
                {Array.from({ length: 3 }).map((_, index) => (
                  <li
                    key={index}
                    className="flex items-center gap-4 rounded-xl border border-zinc-900 bg-zinc-900/40 p-4"
                  >
                    <div className="h-12 w-12 shrink-0 animate-pulse rounded-lg bg-zinc-800" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3 w-2/3 animate-pulse rounded bg-zinc-800" />
                      <div className="h-3 w-1/3 animate-pulse rounded bg-zinc-800/70" />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="mt-8">
          <SubscriptionSettings slug={brand.slug} />
        </section>
      </div>
    </div>
  );
}

function NewsRow({ item }: { item: BrandNewsItem }) {
  return (
    <li>
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-4 rounded-xl border border-zinc-900 bg-zinc-900/40 p-4 transition-colors hover:border-zinc-700 hover:bg-zinc-900"
      >
        <BrandThumbnail
          imageUrl={item.image_url}
          brandSlug={item.brand_slug}
          className="h-14 w-14"
        />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">
            {item.category}
          </p>
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

function HypeBadge({ score }: { score: number }) {
  return (
    <div className="inline-flex shrink-0 flex-col items-center rounded-2xl border border-zinc-800 bg-zinc-950 px-5 py-3">
      <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
        Hype Index
      </span>
      <span className="mt-1 text-2xl font-semibold tabular-nums text-zinc-50">
        {score}
        <span className="text-base font-normal text-zinc-500">/100</span>
      </span>
    </div>
  );
}

function BackArrow() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      className="h-4 w-4"
    >
      <path
        d="M12 15l-5-5 5-5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
