import type { PointerEvent } from "react";

// On-screen accessory keys for touch devices (iPad/phone soft keyboards lack
// Ctrl/Alt/arrows). Each key injects a byte sequence into the active session's
// PTY; Ctrl/Alt are sticky modifiers applied to the next typed character
// (handled in Terminal's onData). Hidden on desktop (pointer: fine).
const KEY =
  "shrink-0 px-2.5 h-8 min-w-[2rem] grid place-items-center rounded-md text-xs font-medium mono select-none " +
  "border border-[var(--border-2)] text-[var(--muted)] active:opacity-60";
const ARMED = "bg-[var(--accent)] text-white border-[var(--accent)]";

export function TerminalKeyBar({
  onKey,
  ctrlArmed,
  altArmed,
  onToggleCtrl,
  onToggleAlt,
}: {
  onKey: (seq: string) => void;
  ctrlArmed: boolean;
  altArmed: boolean;
  onToggleCtrl: () => void;
  onToggleAlt: () => void;
}) {
  // preventDefault on pointerdown so tapping a key never blurs the terminal /
  // dismisses the soft keyboard (same trick the notes toolbar uses).
  const tap = (fn: () => void) => ({
    onPointerDown: (e: PointerEvent) => {
      e.preventDefault();
      fn();
    },
  });
  const sep = <span className="shrink-0 w-px h-5 bg-[var(--border)] mx-0.5" />;
  return (
    <div className="flex items-center gap-1 px-2 py-1 overflow-x-auto border-t border-[var(--border)] bg-[var(--panel)] shrink-0">
      <button className={KEY} {...tap(() => onKey("\x1b"))}>esc</button>
      <button className={KEY} {...tap(() => onKey("\t"))}>tab</button>
      <button className={`${KEY} ${ctrlArmed ? ARMED : ""}`} {...tap(onToggleCtrl)}>ctrl</button>
      <button className={`${KEY} ${altArmed ? ARMED : ""}`} {...tap(onToggleAlt)}>alt</button>
      <button className={KEY} {...tap(() => onKey("\x03"))}>^C</button>
      {sep}
      <button className={KEY} {...tap(() => onKey("\x1b[D"))}>←</button>
      <button className={KEY} {...tap(() => onKey("\x1b[B"))}>↓</button>
      <button className={KEY} {...tap(() => onKey("\x1b[A"))}>↑</button>
      <button className={KEY} {...tap(() => onKey("\x1b[C"))}>→</button>
      {sep}
      {["|", "/", "~", "-"].map((c) => (
        <button key={c} className={KEY} {...tap(() => onKey(c))}>{c}</button>
      ))}
    </div>
  );
}
