import { create } from "zustand";
import type {
  AppSettings,
  AppState,
  Group,
  Note,
  PrimaryTab,
  ServerMessage,
  Session,
  SessionCommand,
} from "../shared/types.ts";
import { applyTheme, getInitialTheme, type Theme } from "./theme.ts";
import { fireNotification } from "./notifications.ts";

type ConnStatus = "connecting" | "open" | "closed";

interface StoreState extends AppState {
  status: ConnStatus;
  activePrimaryTabId: string | null;
  activeSessionId: string | null;
  // Remembers which session was last active in each workspace so switching
  // tabs and back restores the previous console instead of blanking it.
  lastSessionByTab: Record<string, string>;
  // Set when this device creates a session; cleared once the matching session
  // patch arrives and focus is applied. Keeps focus creator-only.
  pendingFocusSessionId: string | null;
  // SessionIds that pinged for attention (claude Notification hook) and haven't
  // been viewed since. Drives the sidebar/tab badges. Cleared on activation.
  attention: Set<string>;
  // Bumped to ask the active Terminal to grab keyboard focus (e.g. after jumping
  // via the command palette). Terminals watch the value, not the contents.
  focusTerminalEpoch: number;
  theme: Theme;
  showClosedSessions: boolean;
  showClosedTabs: boolean;
  showCommandPalette: boolean;
  // On-screen terminal key bar (Esc/Ctrl/arrows…). Per-device pref persisted to
  // localStorage; defaults on for touch devices, off on desktop.
  showKeyBar: boolean;
  sessionCommands: SessionCommand[];
  // Note ids whose last local edit the server rejected as stale (a newer remote
  // edit exists). NotesPanel shows a resolve banner for the active note in here.
  noteConflicts: Set<string>;

  setStatus: (s: ConnStatus) => void;
  applyServerMessage: (msg: ServerMessage) => void;
  setActivePrimaryTab: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  requestFocus: (id: string) => void;
  focusActiveTerminal: () => void;
  toggleTheme: () => void;
  toggleClosedSessions: () => void;
  toggleClosedTabs: () => void;
  toggleCommandPalette: () => void;
  toggleKeyBar: () => void;
  clearNoteConflict: (id: string) => void;
}

// On-screen key bar default: persisted choice, else on for touch (coarse pointer).
const KEYBAR_KEY = "tabterm-keybar";
function initKeyBar(): boolean {
  const saved = localStorage.getItem(KEYBAR_KEY);
  if (saved === "1") return true;
  if (saved === "0") return false;
  return typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
}

// Fallback used before the server `init` message arrives; mirrors the DB defaults
// so terminals render with sane font metrics on first paint.
const DEFAULT_SETTINGS: AppSettings = {
  termFontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  termFontSize: 13,
  termLineHeight: 1.0,
  termTheme: "Slate Standard",
  showSidebar: true,
  showNotes: true,
};

const empty: AppState = {
  primaryTabs: {},
  groups: {},
  sessions: {},
  order: {},
  notes: {},
  settings: DEFAULT_SETTINGS,
};

// Return the attention set with `id` removed. Reuses the existing reference when
// there's nothing to remove, so activation doesn't churn unrelated subscribers.
function cleared(get: () => StoreState, id: string | null): Set<string> {
  const cur = get().attention;
  if (!id || !cur.has(id)) return cur;
  const next = new Set(cur);
  next.delete(id);
  return next;
}

// Same reuse-when-unchanged trick for the note-conflict set when a note goes away.
function clearedConflict(get: () => StoreState, id: string | null): Set<string> {
  const cur = get().noteConflicts;
  if (!id || !cur.has(id)) return cur;
  const next = new Set(cur);
  next.delete(id);
  return next;
}

// Look up the remembered session for a tab and return it only if it still
// points to an open session in that workspace; otherwise null.
function restoreFor(get: () => StoreState, tabId: string | null): string | null {
  if (!tabId) return null;
  const sid = get().lastSessionByTab[tabId];
  if (!sid) return null;
  const s = get().sessions[sid];
  if (!s || s.primaryTabId !== tabId || s.closedAt != null) return null;
  return sid;
}

export const useStore = create<StoreState>((set, get) => ({
  ...empty,
  status: "connecting",
  activePrimaryTabId: null,
  activeSessionId: null,
  lastSessionByTab: {},
  pendingFocusSessionId: null,
  attention: new Set(),
  focusTerminalEpoch: 0,
  theme: getInitialTheme(),
  showClosedSessions: false,
  showClosedTabs: false,
  showCommandPalette: false,
  showKeyBar: initKeyBar(),
  sessionCommands: [],
  noteConflicts: new Set(),

  setStatus: (status) => set({ status }),

  setActivePrimaryTab: (id) => {
    const restored = restoreFor(get, id);
    set({ activePrimaryTabId: id, activeSessionId: restored, attention: cleared(get, restored) });
  },
  setActiveSession: (id) => {
    const tabId = get().activePrimaryTabId;
    const next = { ...get().lastSessionByTab };
    if (id && tabId) next[tabId] = id;
    set({ activeSessionId: id, lastSessionByTab: next, attention: cleared(get, id) });
  },
  requestFocus: (id) => set({ pendingFocusSessionId: id }),
  focusActiveTerminal: () => set({ focusTerminalEpoch: get().focusTerminalEpoch + 1 }),
  toggleTheme: () => {
    const theme = get().theme === "dark" ? "light" : "dark";
    applyTheme(theme);
    set({ theme });
  },
  toggleClosedSessions: () => set({ showClosedSessions: !get().showClosedSessions }),
  toggleClosedTabs: () => set({ showClosedTabs: !get().showClosedTabs }),
  toggleCommandPalette: () => set({ showCommandPalette: !get().showCommandPalette }),
  toggleKeyBar: () => {
    const v = !get().showKeyBar;
    localStorage.setItem(KEYBAR_KEY, v ? "1" : "0");
    set({ showKeyBar: v });
  },
  clearNoteConflict: (id) => {
    const cur = get().noteConflicts;
    if (!cur.has(id)) return;
    const next = new Set(cur);
    next.delete(id);
    set({ noteConflicts: next });
  },

  applyServerMessage: (msg) => {
    if (msg.type === "init") {
      const { state, sessionCommands } = msg;
      const firstTab = Object.values(state.primaryTabs)
        .filter((t) => t.closedAt == null)
        .sort((a, b) => a.position - b.position)[0];
      const activePrimaryTabId = get().activePrimaryTabId ?? firstTab?.id ?? null;
      set({
        ...state,
        sessionCommands,
        activePrimaryTabId,
        activeSessionId: get().activeSessionId ?? restoreFor(get, activePrimaryTabId),
      });
      return;
    }

    if (msg.type === "notify") {
      const session = get().sessions[msg.sessionId];
      if (!session) return;
      // Already looking at this exact session in a focused window → nothing to do.
      const focusedHere =
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        get().activeSessionId === msg.sessionId;
      if (focusedHere) return;
      // Badge it (always), so a different-session/different-device view still cues.
      const attention = new Set(get().attention);
      attention.add(msg.sessionId);
      set({ attention });
      // OS notification only when the window itself isn't focused.
      if (document.hidden || !document.hasFocus()) {
        fireNotification(session.label, msg.message, msg.sessionId, () => {
          get().setActivePrimaryTab(session.primaryTabId);
          get().setActiveSession(msg.sessionId);
        });
      }
      return;
    }

    if (msg.type === "note:conflict") {
      const n = msg.note;
      const conflicts = new Set(get().noteConflicts);
      conflicts.add(n.id);
      set({ notes: { ...get().notes, [n.id]: n }, noteConflicts: conflicts });
      return;
    }

    // patch
    if (msg.op === "delete") {
      if (msg.entity === "note") {
        const notes = { ...get().notes };
        delete notes[msg.id];
        set({ notes, noteConflicts: clearedConflict(get, msg.id) });
        return;
      }
      if (msg.entity === "session") {
        const sessions = { ...get().sessions };
        delete sessions[msg.id];
        const notes = { ...get().notes };
        for (const [nid, n] of Object.entries(notes)) {
          if (n.sessionId === msg.id) delete notes[nid];
        }
        const activeSessionId =
          get().activeSessionId === msg.id ? null : get().activeSessionId;
        const lastSessionByTab = { ...get().lastSessionByTab };
        for (const [tid, sid] of Object.entries(lastSessionByTab)) {
          if (sid === msg.id) delete lastSessionByTab[tid];
        }
        set({ sessions, notes, activeSessionId, lastSessionByTab });
      }
      if (msg.entity === "primaryTab") {
        const primaryTabs = { ...get().primaryTabs };
        delete primaryTabs[msg.id];
        // Drop sessions/notes/order belonging to the purged workspace too —
        // the server sends individual session-delete patches but order is
        // tab-keyed and we own that cleanup client-side.
        const sessions = { ...get().sessions };
        const notes = { ...get().notes };
        const purgedSessionIds = new Set<string>();
        for (const sid of Object.keys(sessions)) {
          if (sessions[sid].primaryTabId === msg.id) {
            purgedSessionIds.add(sid);
            delete sessions[sid];
          }
        }
        for (const [nid, n] of Object.entries(notes)) {
          if (purgedSessionIds.has(n.sessionId)) delete notes[nid];
        }
        const order = { ...get().order };
        delete order[msg.id];
        const lastSessionByTab = { ...get().lastSessionByTab };
        delete lastSessionByTab[msg.id];
        let activePrimaryTabId = get().activePrimaryTabId;
        let activeSessionId = get().activeSessionId;
        if (activePrimaryTabId === msg.id) {
          const fallback = Object.values(primaryTabs)
            .filter((t) => t.closedAt == null)
            .sort((a, b) => a.position - b.position)[0];
          activePrimaryTabId = fallback?.id ?? null;
          activeSessionId = restoreFor(get, activePrimaryTabId);
        }
        set({
          primaryTabs,
          sessions,
          notes,
          order,
          lastSessionByTab,
          activePrimaryTabId,
          activeSessionId,
        });
      }
      return;
    }

    switch (msg.entity) {
      case "primaryTab": {
        const t = msg.data as PrimaryTab;
        const primaryTabs = { ...get().primaryTabs, [t.id]: t };
        // If the user just hid the workspace they were on, jump to the first
        // remaining open one so they don't end up staring at an empty view.
        let activePrimaryTabId = get().activePrimaryTabId;
        let activeSessionId = get().activeSessionId;
        if (t.closedAt != null && activePrimaryTabId === t.id) {
          const fallback = Object.values(primaryTabs)
            .filter((other) => other.closedAt == null)
            .sort((a, b) => a.position - b.position)[0];
          activePrimaryTabId = fallback?.id ?? null;
          activeSessionId = restoreFor(get, activePrimaryTabId);
        }
        set({ primaryTabs, activePrimaryTabId, activeSessionId });
        break;
      }
      case "group": {
        const g = msg.data as Group;
        set({ groups: { ...get().groups, [g.id]: g } });
        break;
      }
      case "session": {
        const s = msg.data as Session;
        const pending = get().pendingFocusSessionId;
        const focusPatch = pending === s.id
          ? { activeSessionId: s.id, pendingFocusSessionId: null }
          : {};
        set({ sessions: { ...get().sessions, [s.id]: s }, ...focusPatch });
        break;
      }
      case "order": {
        const { primaryTabId, order } = msg.data as {
          primaryTabId: string;
          order: string[];
        };
        set({ order: { ...get().order, [primaryTabId]: order } });
        break;
      }
      case "note": {
        const n = msg.data as Note;
        set({ notes: { ...get().notes, [n.id]: n } });
        break;
      }
      case "settings": {
        set({ settings: msg.data as AppSettings });
        break;
      }
    }
  },
}));
