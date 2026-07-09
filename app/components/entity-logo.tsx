"use client";

import { useState } from "react";
import { Building2, Star } from "lucide-react";

import { getEntityLogoUrlForEntity } from "@/lib/brand-assets";
import type { EntityCategory } from "@/lib/entities";

function IconPill({
  children,
  size,
  className = "",
}: {
  children: React.ReactNode;
  size: number;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-neutral-800/90 ring-1 ring-inset ring-neutral-700/60 ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {children}
    </span>
  );
}

function TrendIcon({
  size,
  className = "",
}: {
  size: number;
  className?: string;
}) {
  return (
    <IconPill size={size} className={className}>
      <Star
        className="text-amber-300/90"
        style={{ width: size * 0.5, height: size * 0.5 }}
        strokeWidth={2}
        fill="currentColor"
        fillOpacity={0.25}
      />
    </IconPill>
  );
}

function BrandFallbackIcon({
  size,
  className = "",
}: {
  size: number;
  className?: string;
}) {
  return (
    <IconPill size={size} className={className}>
      <Building2
        className="text-neutral-400"
        style={{ width: size * 0.5, height: size * 0.5 }}
        strokeWidth={2}
      />
    </IconPill>
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
  const isTrend = category === "trend";

  if (isTrend) {
    return <TrendIcon size={size} className={className} />;
  }

  const logoUrl = getEntityLogoUrlForEntity(name);
  if (failed || !logoUrl) {
    return <BrandFallbackIcon size={size} className={className} />;
  }

  return (
    <img
      src={logoUrl}
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
