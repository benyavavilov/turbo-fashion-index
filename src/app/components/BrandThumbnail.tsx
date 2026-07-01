"use client";

import { useState } from "react";

export interface BrandThumbnailProps {
  imageUrl: string;
  brandSlug: string;
  /** Optional brand logo used as a fallback when the item image is missing/broken. */
  logoUrl?: string | null;
  /** Tailwind sizing/spacing classes (e.g. "h-14 w-14"). */
  className?: string;
}

export default function BrandThumbnail({
  imageUrl,
  brandSlug,
  logoUrl,
  className = "",
}: BrandThumbnailProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);

  const base = `shrink-0 overflow-hidden rounded-lg ${className}`;

  // Tier 1: the item's own image.
  if (imageUrl && !imageFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt=""
        onError={() => setImageFailed(true)}
        className={`${base} object-cover`}
      />
    );
  }

  // Tier 2: the brand's logo.
  if (logoUrl && !logoFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt=""
        onError={() => setLogoFailed(true)}
        className={`${base} bg-zinc-900 object-contain p-2`}
      />
    );
  }

  // Tier 3: a stylized initial derived from the brand slug.
  const letter = (brandSlug.trim()[0] ?? "?").toUpperCase();

  return (
    <div
      aria-hidden="true"
      className={`${base} flex items-center justify-center border border-zinc-700/50 bg-gradient-to-br from-zinc-800 via-zinc-900 to-black`}
    >
      <span className="text-lg font-bold tracking-tight text-zinc-100">
        {letter}
      </span>
    </div>
  );
}
