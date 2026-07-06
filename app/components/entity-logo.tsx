"use client";

import { Hash, TrendingUp } from "lucide-react";
import { useState } from "react";

import {
  clearbitLogoUrl,
  getBrandDomain,
} from "@/lib/brand-assets";
import type { EntityCategory } from "@/app/actions";

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
  const isTrend = category === "trend" || !domain;

  if (isTrend || failed || !domain) {
    const Icon = name.includes("#") ? Hash : TrendingUp;
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-full bg-neutral-800 text-neutral-400 ${className}`}
        style={{ width: size, height: size }}
      >
        <Icon style={{ width: size * 0.55, height: size * 0.55 }} />
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={clearbitLogoUrl(domain)}
      alt=""
      width={size}
      height={size}
      className={`shrink-0 rounded-full bg-white/10 object-contain ${className}`}
      onError={() => setFailed(true)}
    />
  );
}
