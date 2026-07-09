"use client";

import { useState } from "react";
import { Lightbulb, Loader2, X } from "lucide-react";

import { submitEntityRequest } from "@/app/actions";
import type { EntityCategory } from "@/lib/entities";

export default function EntitySuggestModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<EntityCategory>("brand");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  if (!open) return null;

  const reset = () => {
    setName("");
    setCategory("brand");
    setNotes("");
    setError(null);
    setSuccess(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const result = await submitEntityRequest({
      name,
      category,
      notes: notes || undefined,
    });

    setSubmitting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setSuccess(true);
    setTimeout(() => handleClose(), 1400);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={handleClose}
        aria-label="Close suggest entity dialog"
      />
      <div
        role="dialog"
        aria-modal
        aria-labelledby="suggest-entity-title"
        className="relative w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-950 p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/15">
              <Lightbulb className="h-4 w-4 text-indigo-400" />
            </div>
            <div>
              <h3
                id="suggest-entity-title"
                className="text-sm font-semibold text-neutral-100"
              >
                Suggest Entity
              </h3>
              <p className="text-xs text-neutral-500">
                Request a new brand or trend for tracking
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {success ? (
          <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-4 text-sm text-emerald-300">
            Thanks — your suggestion was submitted for review.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="suggest-name"
                className="mb-1.5 block text-xs font-medium text-neutral-400"
              >
                Name
              </label>
              <input
                id="suggest-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Salomon"
                className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-indigo-500/50"
              />
            </div>

            <div>
              <span className="mb-1.5 block text-xs font-medium text-neutral-400">
                Type
              </span>
              <div className="inline-flex rounded-lg border border-neutral-800 bg-neutral-900/60 p-0.5">
                {(["brand", "trend"] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setCategory(type)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition ${
                      category === type
                        ? "bg-neutral-800 text-neutral-100"
                        : "text-neutral-500 hover:text-neutral-300"
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label
                htmlFor="suggest-notes"
                className="mb-1.5 block text-xs font-medium text-neutral-400"
              >
                Notes <span className="text-neutral-600">(optional)</span>
              </label>
              <textarea
                id="suggest-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="Why should we track this?"
                className="w-full resize-none rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-indigo-500/50"
              />
            </div>

            {error && (
              <p className="text-xs text-rose-400">{error}</p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg border border-neutral-800 px-3 py-2 text-sm text-neutral-400 hover:bg-neutral-900"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !name.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Submit
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
