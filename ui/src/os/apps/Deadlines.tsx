import { useState } from "react";

import { kernel } from "../api/client";
import type { DeadlineItem } from "../api/types";
import { Icon } from "../components/Icon";
import {
  Button,
  Column,
  ErrorNotice,
  ListView,
  StateDot,
  StatusBar,
  Toolbar,
  formatWhen,
  useSort,
} from "../components/widgets";
import { usePoll } from "../hooks/usePoll";
import { useDesktop } from "../kernel/desktop";

/**
 * The Deadlines mailbox.
 *
 * Airflow 3 deadlines are the feature nobody can see: they have no public REST API at
 * all, so no UI anywhere shows them. This reads the `deadline` and `deadline_alert`
 * tables through the kernel, which makes this window the only place a deadline is
 * visible.
 *
 * A missed deadline is unread mail - something was due, nobody delivered, and the
 * callback fired. So it renders bold, with the flag up.
 */
export function Deadlines() {
  const desktop = useDesktop();
  const [selected, setSelected] = useState<string | null>(null);
  const [missedOnly, setMissedOnly] = useState(false);

  const { data, error, initial, refresh } = usePoll(() => kernel.deadlines(missedOnly), {
    deps: [missedOnly],
    interval: 20_000,
  });

  const items = data ?? [];
  const current = items.find((item) => item.id === selected) ?? items[0];
  const missed = items.filter((item) => item.missed).length;

  const columns: Column<DeadlineItem>[] = [
    {
      key: "subject",
      label: "Subject",
      render: (item) => (
        <span style={{ fontWeight: item.missed ? "bold" : "normal" }}>
          <StateDot state={item.missed ? "failed" : "queued"} />
          {item.name ?? item.description ?? "(unnamed deadline)"}
        </span>
      ),
      sort: (item) => item.name ?? "",
    },
    {
      key: "dag",
      label: "Dag",
      render: (item) => item.dag_id ?? "(deployment)",
      sort: (item) => item.dag_id ?? "",
    },
    {
      key: "due",
      label: "Due",
      render: (item) => (
        <span style={{ fontWeight: item.missed ? "bold" : "normal" }}>
          {formatWhen(item.deadline_time)}
        </span>
      ),
      sort: (item) => item.deadline_time,
    },
    {
      key: "status",
      label: "Status",
      render: (item) => (item.missed ? "Missed" : dueWord(item.deadline_time)),
      sort: (item) => (item.missed ? 0 : 1),
    },
    { key: "reference", label: "Measured from", render: (item) => item.reference ?? "", sort: (item) => item.reference ?? "" },
  ];
  const sorter = useSort(columns, "due", "asc");

  if (error) return <ErrorNotice error={error} />;

  return (
    <>
      <ListView
        columns={columns}
        empty={
          initial
            ? "Checking for deadlines…"
            : missedOnly
              ? "No deadlines have been missed."
              : "No deadlines are defined. Add a DeadlineAlert to a dag to see one here."
        }
        onSelect={(item) => setSelected(item.id)}
        rowKey={(item) => item.id}
        rows={sorter.apply(items)}
        selectedKey={current?.id ?? null}
        {...sorter}
      />

      {current ? (
        <div className="aos-panel" style={{ flex: "none", marginTop: 4, padding: 10 }}>
          <div className="aos-row" style={{ alignItems: "flex-start", gap: 10 }}>
            <Icon name={current.missed ? "mailbox-full" : "mailbox"} size={32} />
            <div className="aos-grow" style={{ userSelect: "text" }}>
              <div style={{ fontWeight: "bold", marginBottom: 4 }}>
                {current.name ?? "(unnamed deadline)"}
              </div>
              {current.description === null ? null : (
                <div style={{ lineHeight: 1.5 }}>{current.description}</div>
              )}
              <table className="aos-table" style={{ background: "transparent", marginTop: 8 }}>
                <tbody>
                  <Row label="Due" value={formatWhen(current.deadline_time)} />
                  <Row label="Status" value={current.missed ? "Missed" : dueWord(current.deadline_time)} />
                  <Row label="Measured from" value={current.reference ?? "—"} />
                  <Row label="Interval" value={current.interval ?? "—"} />
                  <Row label="Callback on miss" value={current.callback ?? "—"} />
                  <Row label="Dag run" value={current.run_id ?? "— (deployment-level)"} />
                  <Row label="Run state" value={current.dag_run_state ?? "—"} />
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      <Toolbar>
        <label className="aos-row" style={{ gap: 4 }}>
          <input
            checked={missedOnly}
            onChange={(event) => setMissedOnly(event.target.checked)}
            type="checkbox"
          />
          Show missed only
        </label>
        <div className="aos-grow" />
        <Button
          disabled={!current?.dag_id || !current?.run_id}
          onClick={() =>
            current?.dag_id && current.run_id
              ? desktop.openApp("explorer", { path: `C:/${current.dag_id}/${current.run_id}` })
              : undefined
          }
          small
        >
          Open Dag Run
        </Button>
        <Button onClick={refresh} small>
          Refresh
        </Button>
      </Toolbar>

      <StatusBar
        panes={[
          missed === 0 ? `${items.length} deadline(s), none missed` : `${missed} missed of ${items.length}`,
          "Deadlines have no REST API; read from the metadata database",
        ]}
      />
    </>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <tr>
      <td style={{ color: "var(--text-disabled)", width: 130 }}>{label}</td>
      <td style={{ maxWidth: "none", whiteSpace: "normal" }}>{value}</td>
    </tr>
  );
}

/** "in 4 minutes" / "overdue by 2 hours", so the list reads like a diary. */
function dueWord(iso: string): string {
  const delta = Date.parse(iso) - Date.now();
  if (Number.isNaN(delta)) return "—";
  const minutes = Math.round(Math.abs(delta) / 60_000);
  const amount =
    minutes < 60
      ? `${minutes} minute${minutes === 1 ? "" : "s"}`
      : minutes < 1440
        ? `${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? "" : "s"}`
        : `${Math.round(minutes / 1440)} day${Math.round(minutes / 1440) === 1 ? "" : "s"}`;
  return delta >= 0 ? `Due in ${amount}` : `Overdue by ${amount}`;
}
