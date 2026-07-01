"use client";

export interface ToggleSwitchProps {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
  size?: "sm" | "md";
}

export default function ToggleSwitch({
  checked,
  onChange,
  label,
  disabled = false,
  size = "md",
}: ToggleSwitchProps) {
  const track = size === "sm" ? "h-5 w-9" : "h-6 w-11";
  const knob = size === "sm" ? "h-3.5 w-3.5" : "h-4.5 w-4.5";
  const translate = size === "sm" ? "translate-x-4" : "translate-x-5";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex ${track} shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-zinc-100" : "bg-zinc-700"
      } ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"}`}
    >
      <span
        className={`inline-block ${knob} transform rounded-full bg-black shadow transition-transform ${
          checked ? translate : "translate-x-1"
        }`}
      />
    </button>
  );
}
