import { useEffect, useState } from "react";
import { ChevronUp, Folder, FolderOpen, Home, X } from "lucide-react";

interface LsResponse {
  path: string;
  parent: string | null;
  home: string;
  entries: { name: string; isDir: boolean }[];
  error?: string;
}

export function CwdPickerModal({
  initial,
  onClose,
  onSelect,
}: {
  // Empty string or "~" → start at $HOME.
  initial: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}) {
  const [data, setData] = useState<LsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  const load = async (path: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/fs/ls?path=${encodeURIComponent(path)}`);
      const body = (await res.json()) as LsResponse;
      if (!res.ok) {
        setError(body.error ?? "failed to read directory");
        return;
      }
      setData(body);
      setTyped(body.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    }
  };

  useEffect(() => {
    void load(initial || "~");
  }, [initial]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const commit = () => {
    if (data) onSelect(data.path);
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg max-h-[80vh] flex flex-col rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
      >
        <div className="flex items-center gap-2 px-4 h-12 border-b border-[var(--border)]">
          <Folder size={15} className="text-[var(--muted)]" />
          <span className="text-sm font-semibold text-[var(--text)] flex-1">
            Choose working directory
          </span>
          <button
            onClick={onClose}
            className="w-7 h-7 grid place-items-center rounded-md text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--hover)]"
            title="Close"
          >
            <X size={15} />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-[var(--border)] flex items-center gap-2">
          <button
            onClick={() => data?.parent && load(data.parent)}
            disabled={!data?.parent}
            className="w-7 h-7 grid place-items-center rounded-md text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-30 disabled:cursor-not-allowed"
            title="Parent directory"
          >
            <ChevronUp size={15} />
          </button>
          <button
            onClick={() => load("~")}
            className="w-7 h-7 grid place-items-center rounded-md text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--hover)]"
            title="Home"
          >
            <Home size={14} />
          </button>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load(typed);
            }}
            placeholder="/absolute/path"
            className="flex-1 mono text-xs bg-[var(--bg)] border border-[var(--border-2)] rounded px-2 py-1 outline-none text-[var(--text)] focus:border-[var(--accent)]"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-0.5 min-h-[200px]">
          {error && (
            <div className="text-sm text-red-400 px-3 py-3">{error}</div>
          )}
          {!error && data && data.entries.length === 0 && (
            <div className="text-sm text-[var(--faint)] px-3 py-6 text-center">
              No subdirectories here.
            </div>
          )}
          {!error &&
            data?.entries.map((e) => (
              <button
                key={e.name}
                onClick={() => load(`${data.path === "/" ? "" : data.path}/${e.name}`)}
                className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]"
              >
                <FolderOpen size={14} className="text-[var(--accent-soft)] shrink-0" />
                <span className="truncate">{e.name}</span>
              </button>
            ))}
        </div>

        <div className="flex items-center gap-2 px-4 h-12 border-t border-[var(--border)]">
          <span className="mono text-xs text-[var(--muted)] flex-1 truncate" title={data?.path}>
            {data?.path ?? "…"}
          </span>
          <button
            onClick={onClose}
            className="px-3 h-7 text-xs rounded-md text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--hover)]"
          >
            Cancel
          </button>
          <button
            onClick={commit}
            disabled={!data}
            className="px-3 h-7 text-xs rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40"
          >
            Select
          </button>
        </div>
      </div>
    </div>
  );
}
