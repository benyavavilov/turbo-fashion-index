"use client";

import { useState } from "react";

export interface BrandThumbnailProps {
  imageUrl: string;
  brandSlug: string;
  /** Tailwind sizing/spacing classes (e.g. "h-14 w-14"). */
  className?: string;
}

export default function BrandThumbnail({
  imageUrl,
  brandSlug,
  className = "",
}: BrandThumbnailProps) {
  const [failed, setFailed] = useState(false);

  const base = `shrink-0 overflow-hidden rounded-lg ${className}`;

  if (imageUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt=""
        onError={() => setFailed(true)}
        className={`${base} object-cover`}
      />
    );
  }

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
