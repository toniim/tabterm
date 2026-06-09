import { create } from "zustand";
import type {
  AppState,
  Group,
  Note,
  PrimaryTab,
  ServerMessage,
  Session,
} from "../shared/types.ts";
import { applyTheme, getInitialTheme, type Theme } from "./theme.ts";

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
  theme: Theme;
  showNotes: boolean;
  showClosedSessions: boolean;
  showClosedTabs: boolean;
  showCommandPalette: boolean;
  termTheme: string;

  setStatus: (s: ConnStatus) => void;
  applyServerMessage: (msg: ServerMessage) => void;
  setActivePrimaryTab: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  requestFocus: (id: string) => void;
  toggleTheme: () => void;
  toggleNotes: () => void;
  toggleClosedSessions: () => void;
  toggleClosedTabs: () => void;
  toggleCommandPalette: () => void;
  setTermTheme: (name: string) => void;
}

const empty: AppState = { primaryTabs: {}, groups: {}, sessions: {}, order: {}, notes: {} };

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
  theme: getInitialTheme(),
  showNotes: true,
  showClosedSessions: false,
  showClosedTabs: false,
  showCommandPalette: false,
  termTheme: "Slate Standard",

  setStatus: (status) => set({ status }),

  setActivePrimaryTab: (id) =>
    set({ activePrimaryTabId: id, activeSessionId: restoreFor(get, id) }),
  setActiveSession: (id) => {
    const tabId = get().activePrimaryTabId;
    const next = { ...get().lastSessionByTab };
    if (id && tabId) next[tabId] = id;
    set({ activeSessionId: id, lastSessionByTab: next });
  },
  requestFocus: (id) => set({ pendingFocusSessionId: id }),
  toggleTheme: () => {
    const theme = get().theme === "dark" ? "light" : "dark";
    applyTheme(theme);
    set({ theme });
  },
  toggleNotes: () => set({ showNotes: !get().showNotes }),
  toggleClosedSessions: () => set({ showClosedSessions: !get().showClosedSessions }),
  toggleClosedTabs: () => set({ showClosedTabs: !get().showClosedTabs }),
  toggleCommandPalette: () => set({ showCommandPalette: !get().showCommandPalette }),
  setTermTheme: (termTheme) => set({ termTheme }),

  applyServerMessage: (msg) => {
    if (msg.type === "init") {
      const { state } = msg;
      const firstTab = Object.values(state.primaryTabs)
        .filter((t) => t.closedAt == null)
        .sort((a, b) => a.position - b.position)[0];
      const activePrimaryTabId = get().activePrimaryTabId ?? firstTab?.id ?? null;
      set({
        ...state,
        activePrimaryTabId,
        activeSessionId: get().activeSessionId ?? restoreFor(get, activePrimaryTabId),
      });
      return;
    }

    // patch
    if (msg.op === "delete") {
      if (msg.entity === "session") {
        const sessions = { ...get().sessions };
        delete sessions[msg.id];
        const notes = { ...get().notes };
        delete notes[msg.id];
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
        for (const sid of Object.keys(sessions)) {
          if (sessions[sid].primaryTabId === msg.id) {
            delete sessions[sid];
            delete notes[sid];
          }
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
        set({ notes: { ...get().notes, [n.sessionId]: n } });
        break;
      }
    }
  },
}));
