import { useEffect, useRef, useState, type ReactNode } from "react";

import { ApiError } from "../api/client";
import { Icon } from "./Icon";

/* Shared chrome used by the apps: buttons, tabs, tables, gauges, status bars. */

export function Button({
  children,
  disabled,
  onClick,
  pressed,
  small,
  title,
  type = "button",
}: {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly small?: boolean;
  readonly pressed?: boolean;
  readonly title?: string;
  readonly type?: "button" | "submit";
}) {
  return (
    <button
      className={`aos-btn${small ? " aos-btn-sm" : ""}`}
      data-pressed={pressed ? "true" : undefined}
      disabled={disabled}
      onClick={onClick}
      title={title}
      type={type === "submit" ? "submit" : "button"}
    >
      {children}
    </button>
  );
}

export function Field({
  autoFocus,
  disabled,
  onChange,
  onKeyDown,
  placeholder,
  style,
  value,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly style?: React.CSSProperties;
  readonly onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  readonly autoFocus?: boolean;
}) {
  return (
    <input
      autoFocus={autoFocus}
      className="aos-field"
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      style={style}
      type="text"
      value={value}
    />
  );
}

export function Tabs({
  active,
  children,
  onChange,
  tabs,
}: {
  readonly tabs: { id: string; label: string }[];
  readonly active: string;
  readonly onChange: (id: string) => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="aos-tabs">
      <div className="aos-tabstrip" role="tablist">
        {tabs.map((tab) => (
          <button
            className="aos-tab"
            data-active={tab.id === active}
            key={tab.id}
            onClick={() => onChange(tab.id)}
            role="tab"
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="aos-tabpanel" role="tabpanel">
        {children}
      </div>
    </div>
  );
}

export function StatusBar({ panes }: { readonly panes: ReactNode[] }) {
  return (
    <div className="aos-statusbar">
      {panes.map((pane, index) => (
        <div key={index}>{pane}</div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ state colour -- */

const STATE_COLORS: Record<string, string> = {
  active: "var(--st-success)",
  broken: "var(--st-failed)",
  deferred: "var(--st-deferred)",
  failed: "var(--st-failed)",
  paused: "var(--st-none)",
  queued: "var(--st-queued)",
  removed: "var(--st-none)",
  restarting: "var(--st-running)",
  running: "var(--st-running)",
  scheduled: "var(--st-queued)",
  skipped: "var(--st-skipped)",
  success: "var(--st-success)",
  up_for_reschedule: "var(--st-queued)",
  up_for_retry: "var(--st-queued)",
  upstream_failed: "var(--st-failed)",
};

export function stateColor(state: string | null | undefined): string {
  return STATE_COLORS[state ?? ""] ?? "var(--st-none)";
}

export function StateDot({ state }: { readonly state: string | null | undefined }) {
  return (
    <span
      className="aos-state-dot"
      style={{ background: stateColor(state) }}
      title={state ?? "no status"}
    />
  );
}

/* ---------------------------------------------------------------- listview -- */

export interface Column<T> {
  key: string;
  label: string;
  width?: number;
  numeric?: boolean;
  render: (row: T) => ReactNode;
  sort?: (row: T) => string | number;
}

export function ListView<T>({
  columns,
  empty = "(empty)",
  onActivate,
  onSelect,
  onSort,
  rowKey,
  rows,
  selectedKey,
  sortDir,
  sortKey,
}: {
  readonly columns: Column<T>[];
  readonly rows: T[];
  readonly rowKey: (row: T) => string;
  readonly selectedKey?: string | null;
  readonly onSelect?: (row: T) => void;
  readonly onActivate?: (row: T) => void;
  readonly empty?: ReactNode;
  readonly sortKey?: string;
  readonly sortDir?: "asc" | "desc";
  readonly onSort?: (key: string) => void;
}) {
  return (
    <div className="aos-listview">
      <table className="aos-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                data-sortable={column.sort ? "true" : undefined}
                key={column.key}
                onClick={column.sort && onSort ? () => onSort(column.key) : undefined}
                style={column.width === undefined ? undefined : { width: column.width }}
              >
                {column.label}
                {sortKey === column.key ? (
                  <span className="aos-sort">{sortDir === "asc" ? "▲" : "▼"}</span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} style={{ color: "var(--text-disabled)", padding: "8px 6px" }}>
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const key = rowKey(row);
              return (
                <tr
                  data-selected={key === selectedKey}
                  key={key}
                  onClick={() => onSelect?.(row)}
                  onDoubleClick={() => onActivate?.(row)}
                >
                  {columns.map((column) => (
                    <td className={column.numeric ? "aos-num" : undefined} key={column.key}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Sort helper so every list view sorts the same way. */
export function useSort<T>(columns: Column<T>[], initial: string, initialDir: "asc" | "desc" = "asc") {
  const [sortKey, setSortKey] = useState(initial);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialDir);

  const onSort = (key: string) => {
    if (key === sortKey) setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const apply = (rows: T[]) => {
    const column = columns.find((c) => c.key === sortKey);
    if (!column?.sort) return rows;
    const getter = column.sort;
    return [...rows].sort((a, b) => {
      const left = getter(a);
      const right = getter(b);
      const cmp =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left).localeCompare(String(right));
      return sortDir === "asc" ? cmp : -cmp;
    });
  };

  return { apply, onSort, sortDir, sortKey };
}

/* ------------------------------------------------------------------ gauges -- */

export function Progress({ value }: { readonly value: number }) {
  return (
    <div className="aos-progress">
      <div className="aos-progress-fill" style={{ width: `${Math.min(Math.max(value, 0), 100)}%` }} />
    </div>
  );
}

/** The blocky LED meter from the Task Manager performance tab. */
export function Meter({ label, value }: { readonly value: number; readonly label: string }) {
  return (
    <div className="aos-col" style={{ alignItems: "center", gap: 3 }}>
      <div className="aos-meter">
        <div className="aos-meter-fill" style={{ height: `${Math.min(Math.max(value, 0), 100)}%` }} />
      </div>
      <div style={{ textAlign: "center" }}>{label}</div>
    </div>
  );
}

/** Scrolling history graph, Win95 Task Manager style. */
export function HistoryGraph({
  color = "#00ff00",
  height = 60,
  values,
}: {
  readonly values: number[];
  readonly height?: number;
  readonly color?: string;
}) {
  const width = 240;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values
    .map((value, index) => `${index * step},${height - (Math.min(Math.max(value, 0), 100) / 100) * height}`)
    .join(" ");

  return (
    <div className="aos-graph" style={{ height }}>
      <svg height={height} preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`} width="100%">
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            stroke="#004000"
            strokeWidth="1"
            x1="0"
            x2={width}
            y1={height * fraction}
            y2={height * fraction}
          />
        ))}
        {values.length > 1 ? (
          <>
            <polyline
              fill="none"
              points={points}
              stroke={color}
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
            <polygon fill={color} opacity="0.25" points={`0,${height} ${points} ${width},${height}`} />
          </>
        ) : null}
      </svg>
    </div>
  );
}

/** Keeps the last `size` samples of a value, for the graphs above. */
export function useHistory(value: number | undefined, size = 60) {
  const [history, setHistory] = useState<number[]>([]);
  const last = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (value === undefined || value === last.current) return;
    last.current = value;
    setHistory((previous) => [...previous, value].slice(-size));
  }, [value, size]);

  return history;
}

/* ------------------------------------------------------------------- misc -- */

export function Toolbar({ children }: { readonly children: ReactNode }) {
  return (
    <div className="aos-row" style={{ flex: "none", padding: "2px 0 4px" }}>
      {children}
    </div>
  );
}

export function ErrorNotice({ error }: { readonly error: Error }) {
  const expired = error instanceof ApiError && error.expired;

  return (
    <div className="aos-row" style={{ alignItems: "flex-start", gap: 8, padding: 10 }}>
      <Icon name={expired ? "warning" : "error"} size={32} />
      <div style={{ userSelect: "text" }}>
        <div style={{ fontWeight: "bold", marginBottom: 4 }}>
          {expired ? "Your logon session has expired." : "The operation could not be completed."}
        </div>
        {expired ? (
          <>
            <div>Log on again to carry on. Anything on screen is as it was when the session ended.</div>
            <div style={{ marginTop: 8 }}>
              <Button onClick={() => globalThis.location.reload()}>Log On…</Button>
            </div>
          </>
        ) : (
          <div>{error.message}</div>
        )}
      </div>
    </div>
  );
}

/** Duration formatter that keeps columns narrow: 4s, 2:07, 1:04:12. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const total = Math.max(Math.floor(seconds), 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  if (minutes > 0) return `${minutes}:${String(secs).padStart(2, "0")}`;
  return `${secs}s`;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    year: "2-digit",
  });
}

export function formatBytes(kilobytes: number): string {
  return `${kilobytes.toLocaleString()} K`;
}
