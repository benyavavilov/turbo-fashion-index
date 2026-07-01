"use client";

import { useEffect, useState } from "react";
import ToggleSwitch from "@/app/components/ToggleSwitch";
import {
  CATEGORY_DEFS,
  defaultSubscription,
  readSubscriptions,
  writeSubscriptions,
  type BrandSubscription,
  type PreferenceKey,
} from "@/app/lib/subscriptions";

export interface SubscriptionSettingsProps {
  slug: string;
}

export default function SubscriptionSettings({ slug }: SubscriptionSettingsProps) {
  const [subscription, setSubscription] = useState<BrandSubscription>(
    defaultSubscription,
  );
  const [hydrated, setHydrated] = useState(false);

  // Read from localStorage only after mount to avoid hydration mismatches.
  useEffect(() => {
    const stored = readSubscriptions()[slug];
    if (stored) {
      setSubscription(stored);
    }
    setHydrated(true);
  }, [slug]);

  const persist = (next: BrandSubscription) => {
    setSubscription(next);
    const all = readSubscriptions();
    all[slug] = next;
    writeSubscriptions(all);
  };

  const toggleSubscribed = () => {
    persist({ ...subscription, isSubscribed: !subscription.isSubscribed });
  };

  const togglePreference = (key: PreferenceKey) => {
    if (!subscription.isSubscribed) {
      return;
    }
    persist({
      ...subscription,
      preferences: {
        ...subscription.preferences,
        [key]: !subscription.preferences[key],
      },
    });
  };

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-6">
      <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-400">
        Subscription &amp; Alerts Settings
      </h2>

      <div className="mt-5 flex items-center justify-between gap-4">
        <div>
          <p className="text-base font-medium text-zinc-100">
            Subscribe to Brand Updates
          </p>
          <p className="mt-1 text-sm text-zinc-500">
            Get notified about this brand&apos;s activity.
          </p>
        </div>
        <ToggleSwitch
          checked={subscription.isSubscribed}
          onChange={toggleSubscribed}
          label="Subscribe to Brand Updates"
          disabled={!hydrated}
        />
      </div>

      <div
        className={`grid transition-all duration-300 ease-out ${
          subscription.isSubscribed
            ? "mt-5 grid-rows-[1fr] opacity-100"
            : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="overflow-hidden">
          <ul className="space-y-1 border-t border-zinc-800/80 pt-4">
            {CATEGORY_DEFS.map((def) => (
              <li
                key={def.key}
                className="flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 hover:bg-zinc-900/60"
              >
                <span className="text-sm text-zinc-300">{def.label}</span>
                <ToggleSwitch
                  checked={subscription.preferences[def.key]}
                  onChange={() => togglePreference(def.key)}
                  label={def.label}
                  size="sm"
                  disabled={!subscription.isSubscribed}
                />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
