import { kernel } from "../api/client";
import { Icon } from "../components/Icon";
import { ErrorNotice, StateDot, StatusBar, formatDuration, formatWhen } from "../components/widgets";
import { usePoll } from "../hooks/usePoll";

/** The System Properties sheet: what this machine actually is. */
export function SystemProperties() {
  const { data, error, initial } = usePoll(kernel.system, { interval: 10_000 });

  if (error) return <ErrorNotice error={error} />;
  if (!data) return <div style={{ padding: 12 }}>{initial ? "Reading system information…" : ""}</div>;

  return (
    <>
      <div className="aos-row aos-grow aos-scroll" style={{ alignItems: "flex-start", gap: 16, padding: 12 }}>
        <div className="aos-col" style={{ alignItems: "center", flex: "none", gap: 6, width: 120 }}>
          <Icon name="airflow" size={64} />
          <div style={{ fontWeight: "bold", textAlign: "center" }}>Airflow OS</div>
          <div style={{ color: "var(--text-disabled)", textAlign: "center" }}>
            Version {data.airflow_os_version}
          </div>
        </div>

        <div className="aos-col aos-grow" style={{ gap: 10 }}>
          <fieldset className="aos-groupbox">
            <legend>System</legend>
            <Row label="Apache Airflow" value={data.airflow_version} />
            <Row label="Python" value={data.python_version} />
            <Row label="Executor" value={data.executor} />
            <Row label="Auth manager" value={data.auth_manager} />
            <Row label="Default timezone" value={data.timezone} />
            <Row label="Dag bundles" value={data.dag_bundles.join(", ")} />
            <Row label="Desktop build" value={__AOS_BUILD__} />
            <Row
              label="Server build"
              value={
                data.bundle_built === null ? (
                  "unknown"
                ) : isStale(data.bundle_built) ? (
                  <span style={{ color: "var(--st-failed)" }}>
                    {data.bundle_built} — reload, this tab is cached
                  </span>
                ) : (
                  data.bundle_built
                )
              }
            />
          </fieldset>

          <fieldset className="aos-groupbox">
            <legend>Scheduler</legend>
            <Row
              label="Status"
              value={
                <>
                  <StateDot state={data.scheduler_alive ? "success" : "failed"} />
                  {data.scheduler_alive ? "Running" : "Not heartbeating"}
                </>
              }
            />
            <Row label="Host" value={data.scheduler_hostname ?? "—"} />
            <Row label="Last heartbeat" value={formatWhen(data.scheduler_heartbeat)} />
            <Row label="Uptime" value={formatDuration(data.uptime_seconds)} />
          </fieldset>

          <fieldset className="aos-groupbox">
            <legend>Performance</legend>
            <Row label="Dags installed" value={String(data.dags_total)} />
            <Row label="Dags paused" value={String(data.dags_paused)} />
            <Row
              label="Dags with import errors"
              value={
                <>
                  {data.dags_broken > 0 ? <StateDot state="failed" /> : null}
                  {data.dags_broken}
                </>
              }
            />
            <Row label="Parallelism" value={`${data.performance.cpu_running} of ${data.parallelism} slots`} />
            <Row
              label="Pool slots"
              value={`${data.performance.mem_used_slots} of ${data.performance.mem_total_slots} occupied`}
            />
            <Row label="Max active tasks per dag" value={String(data.max_active_tasks_per_dag)} />
          </fieldset>
        </div>
      </div>
      <StatusBar panes={[`${data.performance.handles.toLocaleString()} task instances on this machine`]} />
    </>
  );
}

/**
 * True when the served bundle is meaningfully newer than the one this tab is running.
 *
 * Compared as instants with a couple of minutes of slack, not as strings: the two
 * timestamps are always a few seconds apart (one is the build, the other the staged
 * file's mtime), and a naive string compare would call every build straddling a minute
 * boundary "cached".
 */
function isStale(serverBuild: string): boolean {
  const server = Date.parse(`${serverBuild.replace(" ", "T")}Z`);
  const desktop = Date.parse(`${__AOS_BUILD__.replace(" ", "T")}Z`);
  if (Number.isNaN(server) || Number.isNaN(desktop)) return false;
  return server - desktop > 120_000;
}

function Row({ label, value }: { readonly label: string; readonly value: React.ReactNode }) {
  return (
    <div className="aos-row" style={{ gap: 16, justifyContent: "space-between" }}>
      <span style={{ color: "var(--text-disabled)" }}>{label}</span>
      <span style={{ textAlign: "right", userSelect: "text" }}>{value}</span>
    </div>
  );
}
