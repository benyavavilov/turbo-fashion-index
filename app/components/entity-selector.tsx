"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, LineChart, Plus, Search, X } from "lucide-react";

import type { EntityMeta } from "@/app/actions";
import EntityLogo from "@/app/components/entity-logo";
import { getBrandTicker } from "@/lib/brand-assets";

export default function EntitySelector({
  entities,
  selected,
  smaEnabled,
  stockEnabled,
  onAdd,
  onRemove,
  onToggleSma,
  onToggleStock,
  disabled = false,
}: {
  entities: EntityMeta[];
  selected: Set<string>;
  smaEnabled: Set<string>;
  stockEnabled: Set<string>;
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
  onToggleSma: (name: string) => void;
  onToggleStock: (name: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const available = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entities
      .filter((e) => !selected.has(e.name))
      .filter((e) => !q || e.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [entities, selected, query]);

  const selectedList = useMemo(
    () =>
      entities
        .filter((e) => selected.has(e.name))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [entities, selected]
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`mb-4 space-y-3 ${disabled ? "pointer-events-none opacity-40" : ""}`}
    >
      <div className="flex min-h-[40px] flex-wrap items-center gap-2">
        {selectedList.length === 0 ? (
          <span className="text-sm text-neutral-600">
            No entities selected — add one to plot.
          </span>
        ) : (
          selectedList.map((entity) => {
            const hasTicker = Boolean(getBrandTicker(entity.name));
            const smaOn = smaEnabled.has(entity.name);
            const stockOn = stockEnabled.has(entity.name);

            return (
              <span
                key={entity.name}
                className="inline-flex items-center gap-1.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 py-1 pl-1.5 pr-1.5 text-sm text-indigo-100"
              >
                <EntityLogo
                  name={entity.name}
                  category={entity.category}
                  size={28}
                />
                <span className="font-medium">{entity.name}</span>

                <button
                  type="button"
                  onClick={() => onToggleSma(entity.name)}
                  title="90-day moving average"
                  aria-label={`${smaOn ? "Hide" : "Show"} 90-day SMA for ${entity.name}`}
                  aria-pressed={smaOn}
                  className={`rounded-full p-1 transition ${
                    smaOn
                      ? "bg-indigo-500/30 text-indigo-200 ring-1 ring-indigo-400/40"
                      : "text-indigo-300/50 hover:bg-indigo-500/15 hover:text-indigo-200"
                  }`}
                >
                  <Activity className="h-3.5 w-3.5" />
                </button>

                {hasTicker && (
                  <button
                    type="button"
                    onClick={() => onToggleStock(entity.name)}
                    title="Stock price overlay"
                    aria-label={`${stockOn ? "Hide" : "Show"} stock overlay for ${entity.name}`}
                    aria-pressed={stockOn}
                    className={`rounded-full p-1 transition ${
                      stockOn
                        ? "bg-amber-500/25 text-amber-200 ring-1 ring-amber-400/40"
                        : "text-indigo-300/50 hover:bg-amber-500/10 hover:text-amber-200"
                    }`}
                  >
                    <LineChart className="h-3.5 w-3.5" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => onRemove(entity.name)}
                  className="rounded-full p-0.5 text-indigo-300/80 transition hover:bg-indigo-500/20 hover:text-white"
                  aria-label={`Remove ${entity.name}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            );
          })
        )}
      </div>

      <div className="relative inline-block">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm font-medium text-neutral-200 transition hover:border-indigo-500/40 hover:bg-neutral-800"
        >
          <Plus className="h-4 w-4 text-indigo-400" />
          Add Entity
        </button>

        {open && (
          <div className="absolute left-0 top-full z-50 mt-2 w-[min(100vw-2rem,360px)] overflow-hidden rounded-xl border border-neutral-700 bg-neutral-950 shadow-2xl">
            <div className="border-b border-neutral-800 p-3">
              <div className="flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
                <Search className="h-4 w-4 shrink-0 text-neutral-500" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search entities…"
                  className="w-full bg-transparent text-sm text-neutral-100 placeholder:text-neutral-600 outline-none"
                />
              </div>
            </div>

            <ul className="max-h-72 overflow-y-auto py-1">
              {available.length === 0 ? (
                <li className="px-4 py-6 text-center text-sm text-neutral-500">
                  {query ? "No matches found." : "All entities are already selected."}
                </li>
              ) : (
                available.map((entity) => (
                  <li key={entity.name}>
                    <button
                      type="button"
                      onClick={() => {
                        onAdd(entity.name);
                        setOpen(false);
                        setQuery("");
                      }}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-neutral-900"
                    >
                      <EntityLogo
                        name={entity.name}
                        category={entity.category}
                        size={32}
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-neutral-100">
                          {entity.name}
                        </p>
                        <p className="text-[10px] uppercase tracking-wider text-neutral-500">
                          {entity.category}
                        </p>
                      </div>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
