import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/App.tsx";
import { getInitialTheme, applyTheme } from "./theme.ts";
import { useStore } from "./store.ts";
import { connect } from "./ws.ts";
import "./index.css";

applyTheme(getInitialTheme());
connect();

// Drive the app height from the visual viewport so the layout collapses above
// the iOS soft keyboard (which overlays the page instead of resizing the layout
// viewport). Without this, the terminal + key bar hide behind the keyboard.
const vv = window.visualViewport;
const syncAppHeight = () => {
  const h = vv?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${h}px`);
};
syncAppHeight();
vv?.addEventListener("resize", syncAppHeight);
vv?.addEventListener("scroll", syncAppHeight); // keyboard show/hide also fires scroll
window.addEventListener("resize", syncAppHeight);

// No beforeunload guard: sessions are durable (tmux-backed) and all state lives
// server-side, so leaving or reloading the page loses nothing — reconnecting
// restores the same shells and notes.

// Returning to the window while a badged session is already on screen means the
// user has effectively seen it — clear that one badge (others stay).
const clearActiveAttention = () => {
  if (!document.hasFocus()) return;
  const { activeSessionId, attention } = useStore.getState();
  if (activeSessionId && attention.has(activeSessionId)) {
    const next = new Set(attention);
    next.delete(activeSessionId);
    useStore.setState({ attention: next });
  }
};
window.addEventListener("focus", clearActiveAttention);
document.addEventListener("visibilitychange", clearActiveAttention);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
