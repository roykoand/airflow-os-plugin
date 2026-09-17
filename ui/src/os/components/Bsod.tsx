import { useEffect, useRef } from "react";

import { airflow } from "../api/client";
import { useDesktop, type CrashState } from "../kernel/desktop";

/**
 * The blue screen.
 *
 * Keeps the original's actual manners: any key dismisses it, and Ctrl+Alt+Del is the
 * more drastic option - here it clears the failed dag run so the scheduler runs it
 * again, which is the closest honest analogue to rebooting.
 *
 * Focused on mount so keystrokes land without the reader having to click first.
 */
export function Bsod({ crash }: { readonly crash: CrashState }) {
  const desktop = useDesktop();
  const surface = useRef<HTMLDivElement>(null);
  const busy = useRef(false);

  useEffect(() => {
    surface.current?.focus();
  }, []);

  const dismiss = () => desktop.crash(null);

  const restart = async () => {
    if (busy.current || !crash.target) return;
    busy.current = true;
    const { dagId, runId } = crash.target;
    try {
      await airflow.clearDagRun(dagId, runId);
      desktop.crash(null);
      await desktop.messageBox({
        detail: `${dagId} · ${runId}`,
        icon: "info",
        text: "The dag run was cleared. The scheduler will run it again.",
        title: "Airflow OS",
      });
    } catch (cause) {
      desktop.crash(null);
      await desktop.messageBox({
        detail: cause instanceof Error ? cause.message : String(cause),
        icon: "error",
        text: "That dag run could not be cleared.",
        title: "Airflow OS",
      });
    } finally {
      busy.current = false;
    }
  };

  return (
    <div
      className="aos-bsod"
      onClick={dismiss}
      onKeyDown={(event) => {
        // Ctrl+Alt+Del first: it is also "any key".
        if (event.ctrlKey && event.altKey && event.key === "Delete") {
          event.preventDefault();
          void restart();
          return;
        }
        dismiss();
      }}
      ref={surface}
      role="alertdialog"
      tabIndex={-1}
    >
      <div className="aos-bsod-title">{crash.title}</div>
      <pre>{crash.lines.join("\n")}</pre>
      <pre className="aos-bsod-cursor" style={{ marginTop: 22, textAlign: "center" }}>
        Press any key to continue{" "}
      </pre>
    </div>
  );
}

/** Windows quoted a fault address; this quotes one derived from the dag, so it is stable. */
function faultAddress(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) & 0xffffffff;
  }
  const segment = (hash >>> 16).toString(16).padStart(4, "0").toUpperCase();
  const offset = (hash & 0xffff).toString(16).padStart(4, "0").toUpperCase();
  return `0028:C${segment}${offset}`;
}

/**
 * Pull the most useful line out of a task log: the last exception it raised.
 *
 * Log tails are noisy, and the line a human looks for is the one at the bottom of the
 * traceback. Falls back to saying so rather than inventing a cause.
 */
export function extractException(log: string): string | undefined {
  // Log lines carry an ISO timestamp prefix, so the exception is never at column 0.
  const pattern =
    /^(?:\d{4}-\d{2}-\d{2}[T ]\S+\s+)?((?:[\w.]+\.)?\w*(?:Error|Exception|Interrupt))\b.*$/u;
  const candidates = log
    .split("\n")
    .map((line) => line.trim())
    .map((line) => pattern.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    // Drop the timestamp, keep "ValueError: could not convert ...".
    .map((match) => match[0].replace(/^\d{4}-\d{2}-\d{2}[T ]\S+\s+/u, ""));
  return candidates.at(-1);
}

/** Build the stop screen for one failed task instance. */
export function crashFor(
  target: { dagId: string; runId: string; taskId: string; state: string; tryNumber: number; maxTries: number },
  exception: string | undefined,
): CrashState {
  const lines = [
    `A fatal exception 0E has occurred at ${faultAddress(target.dagId + target.taskId)} in DAG`,
    `${target.dagId}(01) + 00010E36. The current dag run has been terminated.`,
    "",
    `*  Failed task: ${target.taskId}  (${target.state}, attempt ${target.tryNumber} of ${
      target.maxTries + 1
    })`,
    `*  ${exception ?? "No exception was recorded in the task log."}`,
    "",
    "*  Press any key to return to the desktop.",
    "*  Press CTRL+ALT+DEL to clear the dag run and try again. You will lose",
    "   any XComs the run had already written.",
  ];
  return { code: "0E", lines, target, title: "Airflow OS" };
}
