import { create } from "zustand";
import type {
  AppState,
  Group,
  Note,
  PrimaryTab,
  ServerMessage,
  Session,
} from "../shared/types.ts";

type ConnStatus = "connecting" | "open" | "closed";

interface StoreState extends AppState {
  status: ConnStatus;
  activePrimaryTabId: string | null;
  activeSessionId: string | null;

  setStatus: (s: ConnStatus) => void;
  applyServerMessage: (msg: ServerMessage) => void;
  setActivePrimaryTab: (id: string) => void;
  setActiveSession: (id: string | null) => void;
}

const empty: AppState = { primaryTabs: {}, groups: {}, sessions: {}, order: {}, notes: {} };

export const useStore = create<StoreState>((set, get) => ({
  ...empty,
  status: "connecting",
  activePrimaryTabId: null,
  activeSessionId: null,

  setStatus: (status) => set({ status }),

  setActivePrimaryTab: (id) => set({ activePrimaryTabId: id, activeSessionId: null }),
  setActiveSession: (id) => set({ activeSessionId: id }),

  applyServerMessage: (msg) => {
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
        const activeSessionId =
          get().activeSessionId === msg.id ? null : get().activeSessionId;
        set({ sessions, activeSessionId });
      } else if (msg.entity === "note") {
        const notes = { ...get().notes };
        delete notes[msg.id];
        set({ notes });
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
        set({ sessions: { ...get().sessions, [s.id]: s } });
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
    }
  },
}));
