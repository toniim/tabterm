// Curated monospace font stacks for the terminal font picker. The stored value
// is the `stack` string (consumed directly by xterm's fontFamily). Only fonts
// installed on the viewer's OS render; each stack falls back gracefully via its
// tail, so an uninstalled choice degrades to a generic monospace instead of breaking.
export interface TermFont {
  label: string;
  stack: string;
}

export const TERM_FONTS: TermFont[] = [
  { label: "System Mono", stack: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  { label: "Menlo", stack: "Menlo, monospace" },
  { label: "Consolas", stack: '"Cascadia Code", Consolas, monospace' },
  { label: "JetBrains Mono", stack: '"JetBrains Mono", ui-monospace, monospace' },
  { label: "Fira Code", stack: '"Fira Code", ui-monospace, monospace' },
  { label: "Source Code Pro", stack: '"Source Code Pro", ui-monospace, monospace' },
];

// Numeric bounds shared by the UI steppers; the server clamps to the same range.
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;
export const LINE_HEIGHT_MIN = 1.0;
export const LINE_HEIGHT_MAX = 2.0;
