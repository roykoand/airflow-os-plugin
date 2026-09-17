import { useMemo, useState } from "react";

import { airflow } from "../api/client";
import { Icon } from "../components/Icon";
import { Button, ErrorNotice, Field, StateDot } from "../components/widgets";
import { usePoll } from "../hooks/usePoll";
import { useDesktop } from "../kernel/desktop";
import { sound } from "../kernel/sound";
import type { AppProps } from "../registry";

/**
 * Start -> Run… but the program you type is a dag id.
 *
 * Triggering goes through the public REST API so it gets the same validation,
 * permissions and audit entry as pressing Trigger in the Airflow UI.
 */
export function RunDialog({ windowId }: AppProps) {
  const desktop = useDesktop();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const { data, error } = usePoll(() => airflow.dags({ limit: 200 }), { interval: 0 });

  const matches = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const dags = data?.dags ?? [];
    if (!needle) return dags.slice(0, 12);
    return dags.filter((dag) => dag.dag_id.toLowerCase().includes(needle)).slice(0, 12);
  }, [data, text]);

  const exact = (data?.dags ?? []).find((dag) => dag.dag_id === text.trim());

  const run = async () => {
    const dagId = exact?.dag_id ?? matches[0]?.dag_id;
    if (!dagId) {
      await desktop.messageBox({
        icon: "error",
        text: `Cannot find '${text.trim()}'. Make sure you typed the dag id correctly.`,
        title: "Run",
      });
      return;
    }

    setBusy(true);
    sound.play("modem");
    try {
      const run_ = await airflow.triggerDag(dagId);
      desktop.close(windowId);
      desktop.openApp("explorer", { path: `C:/${dagId}/${run_.dag_run_id}` });
    } catch (cause) {
      await desktop.messageBox({
        detail: cause instanceof Error ? cause.message : String(cause),
        icon: "error",
        text: `${dagId} could not be triggered.`,
        title: "Run",
      });
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorNotice error={error} />;

  return (
    <div className="aos-col aos-grow" style={{ gap: 8, padding: 10 }}>
      <div className="aos-row" style={{ alignItems: "flex-start", gap: 10 }}>
        <Icon name="run" size={32} />
        <div style={{ lineHeight: 1.5 }}>
          Type the id of a dag and Airflow OS will trigger a new run of it.
        </div>
      </div>

      <div className="aos-row">
        <span style={{ width: 40 }}>Open:</span>
        <Field
          autoFocus
          onChange={setText}
          onKeyDown={(event) => {
            if (event.key === "Enter") void run();
          }}
          placeholder="dag_id"
          style={{ flex: 1 }}
          value={text}
        />
      </div>

      <div className="aos-well aos-grow aos-scroll" style={{ minHeight: 90 }}>
        {matches.map((dag) => (
          <button
            className="aos-menu-item"
            key={dag.dag_id}
            onClick={() => setText(dag.dag_id)}
            onDoubleClick={() => void run()}
            type="button"
          >
            <StateDot state={dag.has_import_errors ? "failed" : dag.is_paused ? "paused" : "success"} />
            <span>{dag.dag_id}</span>
            <span className="aos-menu-accel" style={{ color: "var(--text-disabled)" }}>
              {dag.is_paused ? "paused" : (dag.timetable_summary ?? "")}
            </span>
          </button>
        ))}
        {matches.length === 0 ? (
          <div style={{ color: "var(--text-disabled)", padding: 6 }}>No dag matches that name.</div>
        ) : null}
      </div>

      <div className="aos-row" style={{ justifyContent: "flex-end" }}>
        <Button disabled={busy || matches.length === 0} onClick={() => void run()}>
          {busy ? "Running…" : "OK"}
        </Button>
        <Button onClick={() => desktop.close(windowId)}>Cancel</Button>
      </div>
    </div>
  );
}
