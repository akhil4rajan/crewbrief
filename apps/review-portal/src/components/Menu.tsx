import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  danger?: boolean;
  onSelect: () => void;
}

interface Props {
  /** Accessible name and visible content of the trigger. */
  trigger: ReactNode;
  triggerLabel?: string;
  triggerClassName?: string;
  items: MenuItem[];
  /** Non-interactive content above the items (e.g. who is signed in). */
  header?: ReactNode;
  disabled?: boolean;
}

/** Menu button: arrow keys move, Esc closes and returns focus, a click outside closes. */
export function Menu({ trigger, triggerLabel, triggerClassName = "btn btn-secondary", items, header, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const entries = Array.from(wrap.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
    const i = entries.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      setOpen(false);
      button.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      entries[(i + 1) % entries.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      entries[(i - 1 + entries.length) % entries.length]?.focus();
    }
  };

  return (
    <div className="menu-wrap" ref={wrap} onKeyDown={onKey}>
      <button
        ref={button}
        type="button"
        className={triggerClassName}
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open && (
        <div id={menuId} role="menu" className="menu">
          {header && <div className="menu-header">{header}</div>}
          {items.map((it) => {
            const Icon = it.icon;
            return (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                className={`menu-item${it.danger ? " menu-item-danger" : ""}`}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
              >
                {Icon && <Icon size={16} aria-hidden="true" />}
                {it.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
