import { useCallback, useEffect, useRef, useState } from "react";

import { airflow, ApiError, kernel } from "../api/client";
import type { ProcessRow } from "../api/types";
import { useDesktop } from "../kernel/desktop";
import { sound } from "../kernel/sound";
import { Button } from "./widgets";

/*
 * "It looks like your dag failed. Would you like help with that?"
 *
 * Clippy watches the process table for failures and offers to triage one. Accepting
 * triggers the `airflow_os_clippy` dag, which gathers the log tail and task metadata
 * and hands them to `@task.llm` (Common AI provider) for an explanation. This
 * component only orchestrates and renders - all the reasoning happens inside Airflow,
 * where it is logged, retried and auditable like any other task.
 */

const TRIAGE_DAG_ID = "airflow_os_clippy";
const TRIAGE_TASK_ID = "explain_failure";
const POLL_MS = 2500;
const POLL_TIMEOUT_MS = 180_000;

const FAILED_STATES = new Set(["failed", "upstream_failed"]);
const TERMINAL_STATES = new Set(["success", "failed", "upstream_failed", "skipped", "removed"]);

interface Verdict {
  headline: string;
  explanation: string;
  likely_cause: string;
  suggested_fix: string;
  confidence: string;
}

type Phase =
  | { kind: "error"; target: ProcessRow | null; title: string; detail: string }
  | { kind: "idle" }
  | { kind: "offer"; target: ProcessRow }
  | { kind: "verdict"; target: ProcessRow; verdict: Verdict }
  | { kind: "working"; target: ProcessRow; step: string };

export function Clippy() {
  const desktop = useDesktop();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // Failures the user has waved away, so Clippy nags only once per attempt.
  const dismissed = useRef(new Set<string>());
  const unmounted = useRef(false);

  useEffect(
    () => () => {
      unmounted.current = true;
    },
    [],
  );

  // Watch for failures, but never interrupt a triage already in flight.
  useEffect(() => {
    if (phase.kind !== "idle") return undefined;

    let stopped = false;
    const look = async () => {
      try {
        const rows = await kernel.processes(true);
        if (stopped) return;
        // Sort explicitly rather than trusting list order: with hundreds of dags
        // there are usually several failures in the window, and offering an
        // arbitrary one gives no clue why Clippy picked it.
        const failure = rows
          .filter(
            (row) =>
              FAILED_STATES.has(row.state) &&
              // Never offer to triage his own triage runs: with no model connection
              // configured those are the newest failures, and Clippy would loop.
              row.dag_id !== TRIAGE_DAG_ID &&
              !dismissed.current.has(keyOf(row)),
          )
          .sort((a, b) => when(b) - when(a))[0];
        if (failure) {
          sound.play("ding");
          setPhase({ kind: "offer", target: failure });
        }
      } catch {
        // A failing poll is not worth interrupting anyone over; the other apps
        // surface API errors already.
      }
    };

    void look();
    const timer = globalThis.setInterval(() => void look(), 15_000);
    return () => {
      stopped = true;
      globalThis.clearInterval(timer);
    };
  }, [phase.kind]);

  const dismiss = useCallback((target: ProcessRow | null) => {
    if (target) dismissed.current.add(keyOf(target));
    setPhase({ kind: "idle" });
  }, []);

  const triage = useCallback(async (target: ProcessRow) => {
    setPhase({ kind: "working", step: "Reading the log", target });

    // Airflow 3 tasks cannot read the metadata DB, so the evidence is collected by
    // the plugin (in the api-server) and travels to the dag in its run conf.
    let evidence: Record<string, unknown>;
    try {
      evidence = await kernel.evidence({
        dag_id: target.dag_id,
        map_index: target.map_index,
        run_id: target.run_id,
        task_id: target.task_id,
        try_number: target.try_number,
      });
    } catch (cause) {
      setPhase({
        detail: cause instanceof Error ? cause.message : String(cause),
        kind: "error",
        target,
        title: "I could not read that task's evidence.",
      });
      return;
    }

    setPhase({ kind: "working", step: "Starting a triage run", target });

    let runId: string;
    try {
      const run = await airflow.triggerDag(TRIAGE_DAG_ID, { conf: { evidence } });
      runId = run.dag_run_id;
    } catch (cause) {
      const missing = cause instanceof ApiError && cause.status === 404;
      setPhase({
        detail: missing
          ? `Copy dags/${TRIAGE_DAG_ID}.py into your dags folder and wait for it to be parsed.`
          : cause instanceof Error
            ? cause.message
            : String(cause),
        kind: "error",
        target,
        title: missing ? "I cannot find my triage dag." : "I could not start a triage run.",
      });
      return;
    }

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let started = false;

    while (Date.now() < deadline) {
      if (unmounted.current) return;
      await wait(POLL_MS);

      let state: string | null = null;
      try {
        const instance = await airflow.taskInstance(TRIAGE_DAG_ID, runId, TRIAGE_TASK_ID);
        state = instance.state;
      } catch {
        // The task instance does not exist until the scheduler expands the run.
        setPhase({ kind: "working", step: "Waiting for the scheduler", target });
        continue;
      }

      if (!started && state !== null) {
        started = true;
        setPhase({ kind: "working", step: "Asking the model", target });
      }

      if (state === "success") {
        try {
          const entry = await airflow.xcom<Verdict | string>(TRIAGE_DAG_ID, runId, TRIAGE_TASK_ID);
          const verdict = normalize(entry.value);
          if (verdict) setPhase({ kind: "verdict", target, verdict });
          else
            setPhase({
              detail: `Unexpected XCom shape from ${TRIAGE_TASK_ID}.`,
              kind: "error",
              target,
              title: "My triage run finished, but I could not read the answer.",
            });
        } catch (cause) {
          setPhase({
            detail: cause instanceof Error ? cause.message : String(cause),
            kind: "error",
            target,
            title: "My triage run finished, but I could not read the answer.",
          });
        }
        return;
      }

      if (state !== null && TERMINAL_STATES.has(state)) {
        // The LLM step failed, usually because no connection is configured. The
        // evidence task still ran, so point at it rather than showing nothing.
        setPhase({
          detail:
            `The ${TRIAGE_TASK_ID} task ended as "${state}". Check its log, and that the ` +
            `connection named by the airflow_os_llm_conn_id variable exists ` +
            `(it defaults to openai_default).`,
          kind: "error",
          target,
          title: "I gathered the evidence, but could not ask the model.",
        });
        return;
      }
    }

    setPhase({
      detail: `Still waiting after ${Math.round(
        POLL_TIMEOUT_MS / 1000,
      )}s. Check that ${TRIAGE_DAG_ID} is not paused, then open it in Explorer to see ` +
        `where the run got to.`,
      kind: "error",
      target,
      title: "My triage run is taking longer than I expected.",
    });
  }, []);

  if (phase.kind === "idle") return null;

  return (
    <div className="aos-clippy">
      <div className="aos-clippy-balloon">
        <div className="aos-clippy-scroll">
          {phase.kind === "offer" ? (
            <>
              <div className="aos-clippy-headline">
                It looks like {phase.target.dag_id} failed.
              </div>
              <div>
                Task <b>{phase.target.task_id}</b> ended as <b>{phase.target.state}</b>{" "}
                {timeAgo(phase.target.end_date ?? phase.target.start_date)}. Would you like help with
                that?
              </div>
              <div className="aos-clippy-section aos-clippy-label">
                This is the most recent failure. Run {phase.target.run_id}.
              </div>
            </>
          ) : null}

          {phase.kind === "working" ? (
            <>
              <div className="aos-clippy-headline">
                Let me take a look
                <span className="aos-clippy-thinking" />
              </div>
              <div>{phase.step}.</div>
              <div className="aos-clippy-section aos-clippy-label">
                Running {TRIAGE_DAG_ID}. This is a real dag run, so you can watch it in Task
                Manager.
              </div>
            </>
          ) : null}

          {phase.kind === "verdict" ? (
            <>
              <div className="aos-clippy-headline">{phase.verdict.headline}</div>
              <div>{phase.verdict.explanation}</div>
              <div className="aos-clippy-section">
                <div className="aos-clippy-label">Likely cause</div>
                <div>{phase.verdict.likely_cause}</div>
              </div>
              <div className="aos-clippy-section">
                <div className="aos-clippy-label">Suggested fix</div>
                <div>{phase.verdict.suggested_fix}</div>
              </div>
              <div className="aos-clippy-section aos-clippy-label">
                Confidence: {phase.verdict.confidence}
              </div>
            </>
          ) : null}

          {phase.kind === "error" ? (
            <>
              <div className="aos-clippy-headline">{phase.title}</div>
              <div>{phase.detail}</div>
            </>
          ) : null}
        </div>

        <div className="aos-clippy-actions">
          {phase.kind === "offer" ? (
            <>
              <Button onClick={() => void triage(phase.target)} small>
                Yes, please
              </Button>
              <Button onClick={() => dismiss(phase.target)} small>
                No thanks
              </Button>
            </>
          ) : null}

          {phase.kind === "working" ? (
            <Button onClick={() => dismiss(phase.target)} small>
              Hide
            </Button>
          ) : null}

          {phase.kind === "verdict" ? (
            <>
              <Button
                onClick={() =>
                  desktop.openApp(
                    "notepad",
                    {
                      dagId: phase.target.dag_id,
                      mapIndex: phase.target.map_index,
                      mode: "log",
                      runId: phase.target.run_id,
                      taskId: phase.target.task_id,
                      tryNumber: Math.max(phase.target.try_number, 1),
                    },
                    { title: `${phase.target.task_id} - Notepad` },
                  )
                }
                small
              >
                Show me the log
              </Button>
              <Button onClick={() => dismiss(phase.target)} small>
                Close
              </Button>
            </>
          ) : null}

          {phase.kind === "error" ? (
            <Button onClick={() => dismiss(phase.target)} small>
              OK
            </Button>
          ) : null}
        </div>
      </div>

      <button
        className="aos-clippy-figure"
        onClick={() => (phase.kind === "offer" ? void triage(phase.target) : undefined)}
        title="Clippy"
        type="button"
      >
        <Paperclip />
      </button>
    </div>
  );
}

/** Sort key for "most recent failure": when it ended, else when it started. */
function when(row: ProcessRow): number {
  const stamp = row.end_date ?? row.start_date;
  return stamp === null ? 0 : new Date(stamp).getTime();
}

/** "4 minutes ago", so it is obvious which incident Clippy is offering to look at. */
function timeAgo(iso: string | null): string {
  if (iso === null) return "at an unknown time";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "at an unknown time";
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Identifies one attempt, so a retry gets a fresh offer. */
function keyOf(row: ProcessRow): string {
  return `${row.dag_id}/${row.run_id}/${row.task_id}/${row.map_index}/${row.try_number}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

/** The LLM task returns the model dump or a JSON string, depending on serialization. */
function normalize(value: unknown): Verdict | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (candidate === null || typeof candidate !== "object") return null;

  const record = candidate as Record<string, unknown>;
  if (typeof record.headline !== "string" || typeof record.explanation !== "string") return null;

  return {
    confidence: String(record.confidence ?? "unknown"),
    explanation: record.explanation,
    headline: record.headline,
    likely_cause: String(record.likely_cause ?? "unknown"),
    suggested_fix: String(record.suggested_fix ?? "unknown"),
  };
}

/** Clippy at 64px: bent wire, googly eyes, permanently helpful. */
function Paperclip() {
  return (
    <svg height={64} viewBox="0 0 40 64" width={40} xmlns="http://www.w3.org/2000/svg">
      <g fill="none" stroke="#8a8a8a" strokeLinecap="round" strokeWidth="4.5">
        <path d="M11 20 v26 a9 9 0 0 0 18 0 V14 a6.5 6.5 0 0 0 -13 0 v30 a3.5 3.5 0 0 0 7 0 V20" />
      </g>
      <g fill="none" stroke="#d8d8d8" strokeLinecap="round" strokeWidth="1.4">
        <path d="M9.7 20 v26 a9 9 0 0 0 18 0 V14 a6.5 6.5 0 0 0 -13 0 v30 a3.5 3.5 0 0 0 7 0 V20" />
      </g>

      <ellipse cx="15" cy="14" fill="#fff" rx="5.2" ry="5.8" stroke="#000" strokeWidth="1.1" />
      <ellipse cx="25" cy="14" fill="#fff" rx="5.2" ry="5.8" stroke="#000" strokeWidth="1.1" />
      <circle className="aos-clippy-pupil" cx="16" cy="15" fill="#000" r="2.4" />
      <circle className="aos-clippy-pupil" cx="26" cy="15" fill="#000" r="2.4" />

      <g fill="none" stroke="#4a4a4a" strokeLinecap="round" strokeWidth="1.6">
        <path d="M10.5 6.5 Q15 4 19.5 6.5" />
        <path d="M20.5 6.5 Q25 4 29.5 6.5" />
      </g>
    </svg>
  );
}
