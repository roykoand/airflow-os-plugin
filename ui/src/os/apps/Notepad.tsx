import { useEffect, useMemo, useState } from "react";

import { airflow, kernel } from "../api/client";
import { Button, ErrorNotice, StatusBar, Toolbar } from "../components/widgets";
import { usePoll } from "../hooks/usePoll";
import { useDesktop } from "../kernel/desktop";
import type { AppProps } from "../registry";

/**
 * Notepad, opening two kinds of document:
 *
 *  - `mode: "file"` - a synthetic file from the kernel filesystem (dag source,
 *    properties, XCom values);
 *  - `mode: "log"`  - a task instance log, streamed from the public REST API so it
 *    inherits whatever log handler the deployment configured.
 */
export function Notepad({ props }: AppProps) {
  const desktop = useDesktop();
  const mode = props.mode === "log" ? "log" : "file";
  const [wrap, setWrap] = useState(true);
  const [follow, setFollow] = useState(false);

  const path = typeof props.path === "string" ? props.path : "";
  const dagId = String(props.dagId ?? "");
  const runId = String(props.runId ?? "");
  const taskId = String(props.taskId ?? "");
  const tryNumber = Number(props.tryNumber ?? 1);
  const mapIndex = Number(props.mapIndex ?? -1);

  const { data, error, initial, refresh } = usePoll(
    () =>
      mode === "log"
        ? airflow.taskLog(dagId, runId, taskId, tryNumber, mapIndex)
        : kernel.read(path).then((file) => file.content),
    { deps: [mode, path, dagId, runId, taskId, tryNumber, mapIndex, follow], interval: follow ? 3000 : 0 },
  );

  const text = data ?? "";
  const lines = useMemo(() => (text ? text.split("\n").length : 0), [text]);

  useEffect(() => {
    if (!follow) return;
    const element = document.querySelector<HTMLElement>("[data-notepad-scroll='true']");
    element?.scrollTo({ top: element.scrollHeight });
  }, [text, follow]);

  if (error) return <ErrorNotice error={error} />;

  return (
    <>
      <Toolbar>
        <Button onClick={refresh} small>
          Refresh
        </Button>
        <Button onClick={() => setWrap((value) => !value)} pressed={wrap} small>
          Word Wrap
        </Button>
        {mode === "log" ? (
          <Button onClick={() => setFollow((value) => !value)} pressed={follow} small>
            Auto-refresh
          </Button>
        ) : null}
        <div className="aos-grow" />
        <Button
          onClick={() =>
            desktop.messageBox({
              detail: mode === "log" ? `${dagId} · ${runId}` : path.replaceAll("/", "\\"),
              icon: "info",
              text:
                mode === "log"
                  ? `Task log for ${taskId}, attempt ${tryNumber}.`
                  : `Read from the Airflow OS filesystem.`,
              title: "Notepad",
            })
          }
          small
        >
          Properties
        </Button>
      </Toolbar>

      <div
        className="aos-well aos-grow aos-scroll aos-mono"
        data-notepad-scroll="true"
        style={{ cursor: "text", padding: "4px 6px", userSelect: "text" }}
      >
        <pre
          style={{
            font: "inherit",
            margin: 0,
            whiteSpace: wrap ? "pre-wrap" : "pre",
            wordBreak: wrap ? "break-word" : "normal",
          }}
        >
          {initial ? "Opening…" : text || "(this document is empty)"}
        </pre>
      </div>

      <StatusBar
        panes={[
          mode === "log" ? `${dagId} · ${taskId} · attempt ${tryNumber}` : path.replaceAll("/", "\\"),
          `Ln ${lines}`,
          `${text.length.toLocaleString()} chars`,
        ]}
      />
    </>
  );
}
