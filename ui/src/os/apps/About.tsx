import { kernel } from "../api/client";
import { Icon } from "../components/Icon";
import { Button, StatusBar } from "../components/widgets";
import { usePoll } from "../hooks/usePoll";
import { useDesktop } from "../kernel/desktop";
import type { AppProps } from "../registry";

const MAPPING: [string, string][] = [
  ["Process", "Task instance"],
  ["PID", "TaskInstance.pid, or a stable synthetic id"],
  ["CPU usage", "Running slots / core.parallelism"],
  ["Memory usage", "Occupied pool slots / total pool slots"],
  ["Priority class", "priority_weight, bucketed"],
  ["Drive C:", "The dag bundle"],
  ["Folders", "Dag → dag run → task instance"],
  ["Files", "Task logs, XCom values, rendered properties"],
  ["Paint", "The dag graph, coloured by task instance state"],
  ["Control Panel", "Variables, Connections, Pools"],
  ["Event Viewer", "The audit log"],
  ["Blue screen", "A dag run that failed"],
];

export function About({ windowId }: AppProps) {
  const desktop = useDesktop();
  const { data } = usePoll(kernel.system, { interval: 0 });

  return (
    <>
      <div className="aos-grow aos-scroll" style={{ padding: 14 }}>
        <div className="aos-row" style={{ alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
          <Icon name="airflow" size={48} />
          <div style={{ userSelect: "text" }}>
            <div style={{ fontSize: 15, fontWeight: "bold" }}>Airflow OS</div>
            <div style={{ marginTop: 2 }}>Version {data?.airflow_os_version ?? "0.1.0"}</div>
            <div style={{ lineHeight: 1.5, marginTop: 6 }}>
              A Windows 95 desktop shell for Apache Airflow {data?.airflow_version ?? "3.1+"}, running as a
              native Airflow plugin. Everything on this desktop is live metadata - there is no simulated data
              anywhere in it.
            </div>
          </div>
        </div>

        <fieldset className="aos-groupbox">
          <legend>What maps to what</legend>
          <table className="aos-table" style={{ background: "transparent" }}>
            <tbody>
              {MAPPING.map(([win, af]) => (
                <tr key={win}>
                  <td style={{ color: "var(--text-disabled)", width: 130 }}>{win}</td>
                  <td style={{ maxWidth: "none", whiteSpace: "normal" }}>{af}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </fieldset>

        <div className="aos-row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
          <Button onClick={() => desktop.close(windowId)}>OK</Button>
        </div>
      </div>
      <StatusBar panes={["Licensed under the Apache License 2.0."]} />
    </>
  );
}
