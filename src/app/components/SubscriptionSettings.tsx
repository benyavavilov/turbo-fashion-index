"use client";

import { useState } from "react";

const NOTIFICATION_OPTIONS = [
  "New Product Drops & Collections",
  "Restock Alerts",
  "Price Drops & Sales",
] as const;

type NotificationState = Record<string, boolean>;

export default function SubscriptionSettings() {
  const [subscribed, setSubscribed] = useState(false);
  const [notifications, setNotifications] = useState<NotificationState>({});

  const toggleNotification = (option: string) => {
    setNotifications((prev) => ({ ...prev, [option]: !prev[option] }));
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
          checked={subscribed}
          onChange={() => setSubscribed((value) => !value)}
          label="Subscribe to Brand Updates"
        />
      </div>

      <div
        className={`grid transition-all duration-300 ease-out ${
          subscribed
            ? "mt-5 grid-rows-[1fr] opacity-100"
            : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="overflow-hidden">
          <ul className="space-y-1 border-t border-zinc-800/80 pt-4">
            {NOTIFICATION_OPTIONS.map((option) => (
              <li
                key={option}
                className="flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 hover:bg-zinc-900/60"
              >
                <span className="text-sm text-zinc-300">{option}</span>
                <ToggleSwitch
                  checked={Boolean(notifications[option])}
                  onChange={() => toggleNotification(option)}
                  label={option}
                  size="sm"
                />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

interface ToggleSwitchProps {
  checked: boolean;
  onChange: () => void;
  label: string;
  size?: "sm" | "md";
}

function ToggleSwitch({ checked, onChange, label, size = "md" }: ToggleSwitchProps) {
  const track = size === "sm" ? "h-5 w-9" : "h-6 w-11";
  const knob = size === "sm" ? "h-3.5 w-3.5" : "h-4.5 w-4.5";
  const translate = size === "sm" ? "translate-x-4" : "translate-x-5";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative inline-flex ${track} shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-zinc-100" : "bg-zinc-700"
      }`}
    >
      <span
        className={`inline-block ${knob} transform rounded-full bg-black shadow transition-transform ${
          checked ? translate : "translate-x-1"
        }`}
      />
    </button>
  );
}
