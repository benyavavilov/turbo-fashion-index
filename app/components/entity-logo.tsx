"use client";

import { useState } from "react";

import { clearbitLogoUrl, getBrandDomain } from "@/lib/brand-assets";
import type { EntityCategory } from "@/app/actions";

const AVATAR_COLORS = [
  "#6366f1",
  "#10b981",
  "#f59e0b",
  "#06b6d4",
  "#a855f7",
  "#ec4899",
  "#3b82f6",
  "#14b8a6",
];

function colorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function LetterAvatar({
  name,
  size,
  className = "",
}: {
  name: string;
  size: number;
  className?: string;
}) {
  const letter = name.trim().charAt(0).toUpperCase() || "?";
  const bg = colorForName(name);

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: bg,
        fontSize: Math.max(10, size * 0.42),
      }}
      aria-hidden
    >
      {letter}
    </span>
  );
}

export default function EntityLogo({
  name,
  category,
  size = 16,
  className = "",
}: {
  name: string;
  category?: EntityCategory;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const domain = getBrandDomain(name);

  if (failed || !domain) {
    return <LetterAvatar name={name} size={size} className={className} />;
  }

  return (
    <img
      src={clearbitLogoUrl(domain)}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      className={`shrink-0 rounded-full bg-white/10 object-contain ${className}`}
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  );
}
