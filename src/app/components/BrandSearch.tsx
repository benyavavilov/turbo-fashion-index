"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  brandToSlug,
  filterByWordBoundaryPrefix,
  type BrandRecord,
} from "@/app/lib/search-config";

export interface BrandSearchProps {
  items: BrandRecord[];
}

export default function BrandSearch({ items }: BrandSearchProps) {
  const router = useRouter();
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const matches = useMemo(
    () => filterByWordBoundaryPrefix(items, query),
    [items, query],
  );

  const selectBrand = useCallback(
    (record: BrandRecord) => {
      setQuery(record.name);
      setIsOpen(false);
      setActiveIndex(-1);
      router.push(`/brands/${record.slug || brandToSlug(record.name)}`);
    },
    [router],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen || matches.length === 0) {
      if (event.key === "ArrowDown" && matches.length > 0) {
        setIsOpen(true);
        setActiveIndex(0);
      }
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % matches.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => (index <= 0 ? matches.length - 1 : index - 1));
        break;
      case "Enter":
        event.preventDefault();
        if (activeIndex >= 0 && matches[activeIndex]) {
          selectBrand(matches[activeIndex]);
        }
        break;
      case "Escape":
        setIsOpen(false);
        setActiveIndex(-1);
        break;
    }
  };

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
        setActiveIndex(-1);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  const showDropdown = isOpen && query.length > 0;

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="rounded-xl border border-zinc-800 bg-zinc-950">
        <label htmlFor={`${listboxId}-input`} className="sr-only">
          Index search
        </label>
        <div className="flex items-center gap-3 px-4 py-3.5">
          <SearchIcon />
          <input
            id={`${listboxId}-input`}
            type="search"
            role="combobox"
            aria-expanded={showDropdown}
            aria-controls={`${listboxId}-listbox`}
            aria-activedescendant={
              activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined
            }
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            value={query}
            placeholder="Search…"
            onChange={(event) => {
              setQuery(event.target.value);
              setIsOpen(true);
              setActiveIndex(-1);
            }}
            onFocus={() => setIsOpen(true)}
            onKeyDown={handleKeyDown}
            className="w-full bg-transparent text-base text-zinc-100 placeholder:text-zinc-600 outline-none"
          />
        </div>

        {showDropdown && (
          <div
            id={`${listboxId}-listbox`}
            role="listbox"
            aria-label="Search matches"
            className="border-t border-zinc-800"
          >
            {matches.length > 0 ? (
              <ul className="max-h-72 overflow-y-auto py-2">
                {matches.map((record, index) => (
                  <li key={record.id} role="presentation">
                    <button
                      id={`${listboxId}-option-${index}`}
                      type="button"
                      role="option"
                      aria-selected={index === activeIndex}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => selectBrand(record)}
                      className={`block w-full px-4 py-2.5 text-left text-sm transition-colors ${
                        index === activeIndex
                          ? "bg-zinc-900 text-zinc-50"
                          : "text-zinc-300 hover:bg-zinc-900/70"
                      }`}
                    >
                      {record.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-3 text-sm text-zinc-600">No matches found.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      className="h-4 w-4 shrink-0 text-zinc-600"
    >
      <path
        d="M9 3.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="m14 14 3 3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
