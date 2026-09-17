import { useState } from "react";

import { airflow } from "../api/client";
import {
  Button,
  Column,
  ErrorNotice,
  Field,
  ListView,
  StateDot,
  StatusBar,
  Toolbar,
  formatWhen,
  useSort,
} from "../components/widgets";
import { usePoll } from "../hooks/usePoll";
import { useDesktop } from "../kernel/desktop";
import type { EventLogEntry } from "../api/types";

/** Event Viewer over Airflow's audit log. */
export function EventViewer() {
  const desktop = useDesktop();
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<number | null>(null);

  const { data, error, initial, refresh } = usePoll(() => airflow.eventLogs({ limit: 200 }), {
    interval: 10_000,
  });

  const rows = (data?.event_logs ?? []).filter((entry) =>
    filter
      ? `${entry.event} ${entry.dag_id ?? ""} ${entry.task_id ?? ""} ${entry.owner ?? ""}`
          .toLowerCase()
          .includes(filter.toLowerCase())
      : true,
  );

  const columns: Column<EventLogEntry>[] = [
    {
      key: "type",
      label: "Type",
      render: (entry) => (
        <>
          <StateDot state={severity(entry.event)} />
          {severityLabel(entry.event)}
        </>
      ),
      sort: (entry) => severityLabel(entry.event),
    },
    { key: "when", label: "Date/Time", render: (entry) => formatWhen(entry.when), sort: (entry) => entry.when },
    { key: "event", label: "Event", render: (entry) => entry.event, sort: (entry) => entry.event },
    { key: "dag", label: "Dag", render: (entry) => entry.dag_id ?? "", sort: (entry) => entry.dag_id ?? "" },
    { key: "task", label: "Task", render: (entry) => entry.task_id ?? "", sort: (entry) => entry.task_id ?? "" },
    { key: "owner", label: "User", render: (entry) => entry.owner ?? "", sort: (entry) => entry.owner ?? "" },
  ];

  const sorter = useSort(columns, "when", "desc");
  const current = rows.find((entry) => entry.event_log_id === selected);

  if (error) return <ErrorNotice error={error} />;

  return (
    <>
      <Toolbar>
        <span>Filter:</span>
        <Field onChange={setFilter} placeholder="event, dag, task or user" value={filter} />
        <Button onClick={refresh} small>
          Refresh
        </Button>
        <div className="aos-grow" />
        <Button
          disabled={!current}
          onClick={() =>
            current
              ? desktop.messageBox({
                  detail: [
                    formatWhen(current.when),
                    current.dag_id ? `dag: ${current.dag_id}` : "",
                    current.task_id ? `task: ${current.task_id}` : "",
                    current.run_id ? `run: ${current.run_id}` : "",
                    current.owner ? `user: ${current.owner}` : "",
                    current.extra ?? "",
                  ]
                    .filter(Boolean)
                    .join("\n"),
                  icon: severity(current.event) === "failed" ? "error" : "info",
                  text: current.event,
                  title: "Event Properties",
                })
              : undefined
          }
          small
        >
          Properties
        </Button>
      </Toolbar>

      <ListView
        columns={columns}
        empty={initial ? "Reading event log…" : "No events match this filter."}
        onSelect={(entry) => setSelected(entry.event_log_id)}
        rowKey={(entry) => String(entry.event_log_id)}
        rows={sorter.apply(rows)}
        selectedKey={selected === null ? null : String(selected)}
        {...sorter}
      />

      <StatusBar panes={[`${rows.length} event(s) of ${data?.total_entries ?? 0}`]} />
    </>
  );
}

const FAILURE_WORDS = ["fail", "error", "delete", "kill", "terminat"];
const WARNING_WORDS = ["clear", "pause", "retry", "skip", "set_task"];

function severity(event: string): string {
  const lower = event.toLowerCase();
  if (FAILURE_WORDS.some((word) => lower.includes(word))) return "failed";
  if (WARNING_WORDS.some((word) => lower.includes(word))) return "queued";
  return "success";
}

function severityLabel(event: string): string {
  const level = severity(event);
  if (level === "failed") return "Error";
  if (level === "queued") return "Warning";
  return "Information";
}
