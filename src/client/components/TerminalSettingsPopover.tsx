import { useEffect, useRef, useState } from "react";
import { ChevronDown, Minus, Plus, Settings } from "lucide-react";
import { useStore } from "../store.ts";
import { sendMessage } from "../ws.ts";
import { TERM_THEME_NAMES } from "../termThemes.ts";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  TERM_FONTS,
} from "../termFonts.ts";
import type { AppSettings } from "../../shared/types.ts";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

const update = (patch: Partial<AppSettings>) => sendMessage({ type: "settings:update", patch });

// Compact +/- stepper used for font size and line height.
function Stepper({
  value,
  onStep,
}: {
  value: string;
  onStep: (dir: -1 | 1) => void;
}) {
  const btn =
    "w-5 h-5 grid place-items-center rounded text-[var(--statusbar-fg)] hover:bg-[var(--statusbar-chip)] disabled:opacity-30";
  return (
    <div className="flex items-center gap-1">
      <button className={btn} onClick={() => onStep(-1)} title="Decrease">
        <Minus size={11} />
      </button>
      <span className="w-9 text-center tabular-nums">{value}</span>
      <button className={btn} onClick={() => onStep(1)} title="Increase">
        <Plus size={11} />
      </button>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="opacity-70">{label}</span>
      {children}
    </div>
  );
}

export function TerminalSettingsPopover() {
  const settings = useStore((s) => s.settings);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selectCls =
    "appearance-none mono text-[11px] font-semibold text-[var(--statusbar-fg)] bg-transparent border border-[var(--statusbar-chip)] rounded pl-2 pr-5 py-0.5 outline-none cursor-pointer hover:border-[var(--statusbar-fg)]";

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-6 h-6 grid place-items-center rounded text-[var(--statusbar-fg)] hover:bg-[var(--statusbar-chip)] transition-colors"
        title="Terminal settings"
      >
        <Settings size={12} />
      </button>

      {open && (
        <div
          className="absolute bottom-8 right-0 z-50 w-64 p-3 rounded-lg border border-[var(--border)] shadow-xl flex flex-col gap-2.5 text-[11px] mono"
          style={{ background: "var(--panel)", color: "var(--statusbar-fg)" }}
        >
          <Row label="Font">
            <div className="relative">
              <select
                value={settings.termFontFamily}
                onChange={(e) => update({ termFontFamily: e.target.value })}
                className={selectCls}
              >
                {TERM_FONTS.map((f) => (
                  <option key={f.label} value={f.stack}>
                    {f.label}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={10}
                className="absolute right-1 top-1/2 -translate-y-1/2 opacity-70 pointer-events-none"
              />
            </div>
          </Row>

          <Row label="Size">
            <Stepper
              value={`${settings.termFontSize}px`}
              onStep={(d) =>
                update({ termFontSize: clamp(settings.termFontSize + d, FONT_SIZE_MIN, FONT_SIZE_MAX) })
              }
            />
          </Row>

          <Row label="Line height">
            <Stepper
              value={round1(settings.termLineHeight).toFixed(1)}
              onStep={(d) =>
                update({
                  termLineHeight: clamp(
                    round1(settings.termLineHeight + d * 0.1),
                    LINE_HEIGHT_MIN,
                    LINE_HEIGHT_MAX,
                  ),
                })
              }
            />
          </Row>

          <Row label="Theme">
            <div className="relative">
              <select
                value={settings.termTheme}
                onChange={(e) => update({ termTheme: e.target.value })}
                className={selectCls}
              >
                {TERM_THEME_NAMES.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={10}
                className="absolute right-1 top-1/2 -translate-y-1/2 opacity-70 pointer-events-none"
              />
            </div>
          </Row>
        </div>
      )}
    </div>
  );
}
