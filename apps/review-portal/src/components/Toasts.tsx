import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api/client";

export type ToastKind = "info" | "success" | "warning" | "error";

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  correlationId?: string;
}

interface ToastApi {
  push: (kind: ToastKind, title: string, detail?: string) => void;
  /** Show an API failure, surfacing the problem+json detail and correlation id. */
  error: (err: unknown, title?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TTL_MS: Record<ToastKind, number> = { info: 4000, success: 4000, warning: 7000, error: 9000 };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const add = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = nextId.current++;
      setToasts((ts) => [...ts.slice(-4), { ...t, id }]);
      window.setTimeout(() => dismiss(id), TTL_MS[t.kind]);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push: (kind, title, detail) => add({ kind, title, detail }),
      error: (err, title = "Something went wrong") => {
        if (err instanceof ApiError) {
          add({
            kind: "error",
            title: err.status ? `${title} (${err.status})` : title,
            detail: err.message,
            correlationId: err.correlationId,
          });
        } else {
          add({ kind: "error", title, detail: err instanceof Error ? err.message : String(err) });
        }
      },
    }),
    [add],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
            <div className="toast-body">
              <strong>{t.title}</strong>
              {t.detail && <p>{t.detail}</p>}
              {t.correlationId && <p className="muted mono small">Ref {t.correlationId}</p>}
            </div>
            <button type="button" className="icon-btn" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
