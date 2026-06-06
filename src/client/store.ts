import { create } from "zustand";
import type {
  AiMessage,
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
  // Set when this device creates a session; cleared once the matching session
  // patch arrives and focus is applied. Keeps focus creator-only.
  pendingFocusSessionId: string | null;
  // Per-session AI history, loaded lazily over REST and kept live via WS.
  aiHistory: Record<string, AiMessage[]>;
  theme: Theme;
  showNotes: boolean;
  termTheme: string;

  setStatus: (s: ConnStatus) => void;
  applyServerMessage: (msg: ServerMessage) => void;
  setActivePrimaryTab: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  requestFocus: (id: string) => void;
  setAiHistory: (sessionId: string, messages: AiMessage[]) => void;
  toggleTheme: () => void;
  toggleNotes: () => void;
  setTermTheme: (name: string) => void;
}

const empty: AppState = { primaryTabs: {}, groups: {}, sessions: {}, order: {}, notes: {} };

export const useStore = create<StoreState>((set, get) => ({
  ...empty,
  status: "connecting",
  activePrimaryTabId: null,
  activeSessionId: null,
  pendingFocusSessionId: null,
  aiHistory: {},
  theme: getInitialTheme(),
  showNotes: true,
  termTheme: "Slate Standard",

  setStatus: (status) => set({ status }),

  setActivePrimaryTab: (id) => set({ activePrimaryTabId: id, activeSessionId: null }),
  setActiveSession: (id) => set({ activeSessionId: id }),
  requestFocus: (id) => set({ pendingFocusSessionId: id }),
  setAiHistory: (sessionId, messages) =>
    set({ aiHistory: { ...get().aiHistory, [sessionId]: messages } }),
  toggleTheme: () => {
    const theme = get().theme === "dark" ? "light" : "dark";
    applyTheme(theme);
    set({ theme });
  },
  toggleNotes: () => set({ showNotes: !get().showNotes }),
  setTermTheme: (termTheme) => set({ termTheme }),

  applyServerMessage: (msg) => {
    if (msg.type === "ai") {
      // Only append if this device has loaded that session's history; otherwise
      // it will fetch the full history when the panel opens.
      const cur = get().aiHistory[msg.sessionId];
      if (cur !== undefined) {
        set({ aiHistory: { ...get().aiHistory, [msg.sessionId]: [...cur, ...msg.messages] } });
      }
      return;
    }

    if (msg.type === "init") {
      const { state } = msg;
      const firstTab = Object.values(state.primaryTabs).sort(
        (a, b) => a.position - b.position,
      )[0];
      set({
        ...state,
        activePrimaryTabId: get().activePrimaryTabId ?? firstTab?.id ?? null,
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
        set({ sessions, notes, activeSessionId });
      }
      return;
    }

    switch (msg.entity) {
      case "primaryTab": {
        const t = msg.data as PrimaryTab;
        set({ primaryTabs: { ...get().primaryTabs, [t.id]: t } });
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
