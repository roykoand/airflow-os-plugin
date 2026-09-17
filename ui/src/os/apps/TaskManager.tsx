import { useMemo, useState } from "react";

import { airflow, kernel } from "../api/client";
import type { ProcessRow } from "../api/types";
import {
  Button,
  Column,
  ErrorNotice,
  HistoryGraph,
  ListView,
  Meter,
  StateDot,
  StatusBar,
  Tabs,
  Toolbar,
  formatBytes,
  formatDuration,
  useHistory,
  useSort,
} from "../components/widgets";
import { usePoll } from "../hooks/usePoll";
import { useDesktop } from "../kernel/desktop";

const POLL_MS = 3000;

/**
 * Task Manager. Ctrl+Alt+Del for your scheduler.
 *
 * Applications = dag runs, Processes = task instances, Performance = parallelism
 * and pool-slot utilisation. Every number is read from live Airflow state; nothing
 * here is simulated.
 */
export function TaskManager() {
  const [tab, setTab] = useState("processes");

  return (
    <Tabs
      active={tab}
      onChange={setTab}
      tabs={[
        { id: "applications", label: "Applications" },
        { id: "processes", label: "Processes" },
        { id: "performance", label: "Performance" },
      ]}
    >
      {tab === "applications" ? <Applications /> : null}
      {tab === "processes" ? <Processes /> : null}
      {tab === "performance" ? <Performance /> : null}
    </Tabs>
  );
}

/* ------------------------------------------------------------ Applications -- */

interface RunRow {
  dagId: string;
  runId: string;
  state: string;
  runType: string;
  start: string | null;
}

function Applications() {
  const desktop = useDesktop();
  const [selected, setSelected] = useState<string | null>(null);

  // "Applications" are dag runs; the fastest way to enumerate the live ones is to
  // roll up the process table, which is already one query.
  const { data, error, initial, refresh } = usePoll(() => kernel.processes(true), {
    interval: POLL_MS,
  });

  const rows = useMemo<RunRow[]>(() => {
    const byRun = new Map<string, RunRow>();
    for (const process of data ?? []) {
      const key = `${process.dag_id}\u0000${process.run_id}`;
      const existing = byRun.get(key);
      const live = ["running", "queued", "scheduled", "deferred", "up_for_retry"].includes(process.state);
      if (existing) {
        if (live) existing.state = "running";
      } else {
        byRun.set(key, {
          dagId: process.dag_id,
          runId: process.run_id,
          runType: process.run_id.split("__")[0] || "scheduled",
          start: process.start_date,
          state: live ? "running" : process.state,
        });
      }
    }
    return [...byRun.values()];
  }, [data]);

  const columns: Column<RunRow>[] = [
    {
      key: "task",
      label: "Task",
      render: (row) => (
        <>
          <StateDot state={row.state} />
          {row.dagId}
        </>
      ),
      sort: (row) => row.dagId,
    },
    { key: "run", label: "Dag Run", render: (row) => row.runId, sort: (row) => row.runId },
    { key: "status", label: "Status", render: (row) => statusWord(row.state), sort: (row) => row.state },
  ];

  const sorter = useSort(columns, "task");

  if (error) return <ErrorNotice error={error} />;

  const current = rows.find((row) => `${row.dagId}\u0000${row.runId}` === selected);

  return (
    <>
      <ListView
        columns={columns}
        empty={initial ? "Reading task list…" : "No dag runs are currently active."}
        onActivate={(row) => desktop.openApp("explorer", { path: `C:/${row.dagId}/${row.runId}` })}
        onSelect={(row) => setSelected(`${row.dagId}\u0000${row.runId}`)}
        rowKey={(row) => `${row.dagId}\u0000${row.runId}`}
        rows={sorter.apply(rows)}
        selectedKey={selected}
        {...sorter}
      />
      <Toolbar>
        <div className="aos-grow" />
        <Button
          disabled={!current}
          onClick={async () => {
            if (!current) return;
            const answer = await desktop.messageBox({
              buttons: [
                { label: "End Task", primary: true, value: "ok" },
                { label: "Cancel", value: "cancel" },
              ],
              detail: "Cleared tasks are picked back up by the scheduler and run again.",
              icon: "warning",
              text: `Clear every task instance in "${current.runId}"?`,
              title: "End Task",
            });
            if (answer !== "ok") return;
            try {
              await airflow.clearDagRun(current.dagId, current.runId);
              refresh();
            } catch (cause) {
              await desktop.messageBox({
                detail: cause instanceof Error ? cause.message : String(cause),
                icon: "error",
                text: "This dag run could not be cleared.",
                title: "Unable to End Task",
              });
            }
          }}
        >
          End Task
        </Button>
        <Button
          disabled={!current}
          onClick={() =>
            current
              ? desktop.openApp("explorer", { path: `C:/${current.dagId}/${current.runId}` })
              : undefined
          }
        >
          Switch To
        </Button>
        <Button onClick={() => desktop.openApp("run", {}, { singleton: true })}>New Task…</Button>
      </Toolbar>
      <StatusBar panes={[`Applications: ${rows.length}`]} />
    </>
  );
}

function statusWord(state: string): string {
  if (["running", "queued", "scheduled", "deferred"].includes(state)) return "Running";
  if (state === "failed" || state === "upstream_failed") return "Not responding";
  return "Finished";
}

/* --------------------------------------------------------------- Processes -- */

function Processes() {
  const desktop = useDesktop();
  const [selected, setSelected] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const { data, error, initial, refresh } = usePoll(() => kernel.processes(showAll), {
    deps: [showAll],
    interval: POLL_MS,
  });
  const { data: perf } = usePoll(kernel.performance, { interval: POLL_MS });

  const columns: Column<ProcessRow>[] = [
    {
      key: "image",
      label: "Image Name",
      render: (row) => (
        <>
          <StateDot state={row.state} />
          {row.image_name}
        </>
      ),
      sort: (row) => row.image_name,
    },
    { key: "pid", label: "PID", numeric: true, render: (row) => row.pid, sort: (row) => row.pid },
    { key: "dag", label: "Dag", render: (row) => row.dag_id, sort: (row) => row.dag_id },
    { key: "owner", label: "User Name", render: (row) => row.owner, sort: (row) => row.owner },
    { key: "state", label: "Status", render: (row) => row.state, sort: (row) => row.state },
    {
      key: "cpu",
      label: "CPU",
      numeric: true,
      render: (row) => (row.state === "running" ? `${row.cpu.toFixed(0)}%` : "—"),
      sort: (row) => row.cpu,
    },
    {
      key: "mem",
      label: "Mem Usage",
      numeric: true,
      render: (row) => formatBytes(row.mem_k),
      sort: (row) => row.mem_k,
    },
    {
      key: "elapsed",
      label: "CPU Time",
      numeric: true,
      render: (row) => formatDuration(row.elapsed),
      sort: (row) => row.elapsed,
    },
    {
      key: "try",
      label: "Try",
      numeric: true,
      render: (row) => `${row.try_number}/${row.max_tries + 1}`,
      sort: (row) => row.try_number,
    },
    { key: "priority", label: "Priority", render: (row) => row.priority, sort: (row) => row.priority_weight },
  ];

  const sorter = useSort(columns, "cpu", "desc");
  const rows = data ?? [];
  const current = rows.find((row) => row.ti_id === selected);

  const endProcess = async () => {
    if (!current) return;
    const answer = await desktop.messageBox({
      buttons: [
        { label: "Yes", primary: true, value: "yes" },
        { label: "No", value: "no" },
      ],
      detail: `${current.dag_id} · ${current.run_id} · pid ${current.pid}`,
      icon: "warning",
      text:
        `Terminating a process can cause undesired results including loss of data. ` +
        `Are you sure you want to terminate ${current.image_name}?`,
      title: "Task Manager Warning",
    });
    if (answer !== "yes") return;

    try {
      const result = await kernel.endProcess(current.ti_id);
      refresh();
      await desktop.messageBox({
        detail: `${result.previous_state ?? "unknown"} → ${result.new_state}`,
        icon: "info",
        text: `${current.image_name} was terminated.`,
        title: "Task Manager",
      });
    } catch (cause) {
      await desktop.messageBox({
        detail: cause instanceof Error ? cause.message : String(cause),
        icon: "error",
        text: "This task instance could not be terminated.",
        title: "Unable to Terminate Process",
      });
    }
  };

  const openLog = () => {
    if (!current) return;
    desktop.openApp(
      "notepad",
      {
        dagId: current.dag_id,
        mapIndex: current.map_index,
        mode: "log",
        runId: current.run_id,
        taskId: current.task_id,
        tryNumber: Math.max(current.try_number, 1),
      },
      { title: `${current.task_id} - Notepad` },
    );
  };

  if (error) return <ErrorNotice error={error} />;

  return (
    <>
      <ListView
        columns={columns}
        empty={initial ? "Reading process list…" : "No task instances are in flight."}
        onActivate={openLog}
        onSelect={(row) => setSelected(row.ti_id)}
        rowKey={(row) => row.ti_id}
        rows={sorter.apply(rows)}
        selectedKey={selected}
        {...sorter}
      />
      <Toolbar>
        <label className="aos-row" style={{ gap: 4 }}>
          <input checked={showAll} onChange={(event) => setShowAll(event.target.checked)} type="checkbox" />
          Show processes from all users
        </label>
        <div className="aos-grow" />
        <Button disabled={!current} onClick={openLog}>
          View Log
        </Button>
        <Button disabled={!current} onClick={endProcess}>
          End Process
        </Button>
      </Toolbar>
      <StatusBar
        panes={[
          `Processes: ${rows.length}`,
          `CPU Usage: ${(perf?.cpu_usage ?? 0).toFixed(0)}%`,
          `Mem Usage: ${perf?.mem_used_slots ?? 0}/${perf?.mem_total_slots ?? 0} slots`,
        ]}
      />
    </>
  );
}

/* ------------------------------------------------------------- Performance -- */

function Performance() {
  const { data, error } = usePoll(kernel.performance, { interval: 2000 });
  const { data: health } = usePoll(airflow.health, { interval: 10_000 });

  const cpuHistory = useHistory(data?.cpu_usage);
  const memHistory = useHistory(data?.mem_usage);

  if (error) return <ErrorNotice error={error} />;

  return (
    <div className="aos-col aos-scroll" style={{ gap: 10 }}>
      <div className="aos-row" style={{ alignItems: "flex-start", gap: 12 }}>
        <Meter label={`Slot Usage\n${(data?.cpu_usage ?? 0).toFixed(0)}%`} value={data?.cpu_usage ?? 0} />
        <div className="aos-grow">
          <div style={{ marginBottom: 3 }}>Slot Usage History (running / parallelism)</div>
          <HistoryGraph values={cpuHistory} />
        </div>
      </div>

      <div className="aos-row" style={{ alignItems: "flex-start", gap: 12 }}>
        <Meter
          label={`Pool Usage\n${(data?.mem_usage ?? 0).toFixed(0)}%`}
          value={data?.mem_usage ?? 0}
        />
        <div className="aos-grow">
          <div style={{ marginBottom: 3 }}>Pool Slot History (occupied / total slots)</div>
          <HistoryGraph color="#ffff00" values={memHistory} />
        </div>
      </div>

      <div className="aos-row" style={{ alignItems: "stretch", gap: 10 }}>
        <fieldset className="aos-groupbox aos-grow">
          <legend>Totals</legend>
          <Stat label="Handles" value={data?.handles ?? 0} />
          <Stat label="Threads" value={data?.threads ?? 0} />
          <Stat label="Processes" value={data?.processes ?? 0} />
        </fieldset>

        <fieldset className="aos-groupbox aos-grow">
          <legend>Task Slots (K)</legend>
          <Stat label="Running" value={data?.cpu_running ?? 0} />
          <Stat label="Queued" value={data?.queued ?? 0} />
          <Stat label="Deferred" value={data?.deferred ?? 0} />
          <Stat label="Parallelism" value={data?.cpu_total ?? 0} />
        </fieldset>

        <fieldset className="aos-groupbox aos-grow">
          <legend>Components</legend>
          {Object.entries(health ?? {}).map(([name, value]) => (
            <div className="aos-row" key={name} style={{ justifyContent: "space-between" }}>
              <span style={{ textTransform: "capitalize" }}>{name.replaceAll("_", " ")}</span>
              <span>
                <StateDot state={value.status === "healthy" ? "success" : "failed"} />
                {value.status ?? "unknown"}
              </span>
            </div>
          ))}
        </fieldset>
      </div>

      <StatusBar panes={[`Dag runs in flight: ${data?.running_dag_runs ?? 0}`]} />
    </div>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="aos-row" style={{ justifyContent: "space-between" }}>
      <span>{label}</span>
      <span className="aos-num">{value.toLocaleString()}</span>
    </div>
  );
}
