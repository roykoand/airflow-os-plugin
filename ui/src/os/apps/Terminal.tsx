import { useEffect, useRef, useState } from "react";

import { airflow, kernel } from "../api/client";
import { useDesktop } from "../kernel/desktop";
import type { AppProps } from "../registry";

/*
 * MS-DOS Prompt. The whole shell runs in the browser: reads go to the kernel API,
 * writes go to Airflow's public REST API, so nothing here bypasses permissions.
 */

const BANNER = [
  "Airflow OS",
  "(C) Copyright The Apache Software Foundation. Licensed under Apache-2.0.",
  "",
  "Type HELP for a list of commands.",
  "",
];

const HELP = [
  "DIR [path]            List a folder of the metadata drive.",
  "CD <path>             Change the current folder.  CD ..  goes up.",
  "TYPE <file>           Print a file (dag.py, properties.json, an XCom value).",
  "TASKLIST              List running task instances, with their PIDs.",
  "KILL <pid>            Terminate a task instance by PID.",
  "DAGS [pattern]        List dags, optionally filtered.",
  "TRIGGER <dag_id>      Trigger a new dag run.",
  "PAUSE|UNPAUSE <dag>   Pause or resume a dag's schedule.",
  "MEM                   Show slot and pool utilisation.",
  "VER                   Show version information.",
  "PAINT [dag_id]        Open a dag's graph in Paint (defaults to the current folder's dag).",
  "START <app>           Open a desktop app (taskmgr, explorer, control, events, paint).",
  "CLS                   Clear the screen.",
  "EXIT                  Close this window.",
];

interface Line {
  id: number;
  text: string;
}

export function Terminal({ windowId }: AppProps) {
  const desktop = useDesktop();
  const [lines, setLines] = useState<Line[]>(() => BANNER.map((text, id) => ({ id, text })));
  const [input, setInput] = useState("");
  const [cwd, setCwd] = useState("C:");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const nextId = useRef(BANNER.length);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  const write = (...text: string[]) => {
    setLines((previous) => [
      ...previous,
      ...text.map((line) => {
        nextId.current += 1;
        return { id: nextId.current, text: line };
      }),
    ]);
  };

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lines]);

  const prompt = `${cwd.replaceAll("/", "\\")}>`;

  const run = async (raw: string) => {
    const line = raw.trim();
    write(`${prompt}${raw}`);
    if (!line) return;

    setHistory((previous) => [...previous, line]);
    setHistoryIndex(-1);

    const [head = "", ...rest] = line.split(/\s+/u);
    const command = head.toLowerCase();
    const argument = rest.join(" ");

    try {
      switch (command) {
        case "help":
        case "?":
          write(...HELP, "");
          break;

        case "cls":
          setLines([]);
          break;

        case "exit":
          desktop.close(windowId);
          break;

        case "ver": {
          const system = await kernel.system();
          write(
            `Airflow OS ${system.airflow_os_version}`,
            `Apache Airflow ${system.airflow_version} on Python ${system.python_version}`,
            `Executor: ${system.executor}`,
            "",
          );
          break;
        }

        case "cd": {
          const target = resolve(cwd, argument);
          await kernel.list(target);
          setCwd(target);
          break;
        }

        case "dir": {
          const target = argument ? resolve(cwd, argument) : cwd;
          const listing = await kernel.list(target);
          write(` Directory of ${listing.title}`, "");
          for (const entry of listing.entries) {
            const kind = entry.kind === "file" ? "        " : "<DIR>   ";
            write(`${kind}${entry.name.padEnd(46)}${entry.state ?? entry.detail ?? ""}`);
          }
          write(`        ${listing.entries.length} item(s)`, "");
          break;
        }

        case "type": {
          if (!argument) {
            write("Syntax: TYPE <file>", "");
            break;
          }
          const file = await kernel.read(resolve(cwd, argument));
          write(...file.content.split("\n"), "");
          break;
        }

        case "tasklist": {
          const processes = await kernel.processes();
          write(
            "Image Name                     PID    Status         Dag",
            "============================== ====== ============== ====================",
          );
          for (const process of processes) {
            write(
              `${process.image_name.slice(0, 30).padEnd(31)}${String(process.pid).padEnd(7)}${process.state.padEnd(15)}${process.dag_id}`,
            );
          }
          write(`        ${processes.length} process(es)`, "");
          break;
        }

        case "kill": {
          const pid = Number.parseInt(argument, 10);
          if (Number.isNaN(pid)) {
            write("Syntax: KILL <pid>", "");
            break;
          }
          // PIDs are decoration: a task with no worker gets a CRC32 into 64512
          // slots, so two rows can share one. Refuse rather than guess - killing
          // the wrong task instance is not a recoverable mistake.
          const matches = (await kernel.processes(true)).filter((row) => row.pid === pid);
          if (matches.length === 0) {
            write(`No process with PID ${pid}.`, "");
            break;
          }
          if (matches.length > 1) {
            write(
              `PID ${pid} is ambiguous - ${matches.length} processes share it:`,
              ...matches.map((row) => `    ${row.image_name.padEnd(30)}${row.dag_id}`),
              "Use Task Manager to pick one.",
              "",
            );
            break;
          }
          const target = matches[0];
          if (target === undefined) break;
          const result = await kernel.endProcess(target.ti_id);
          write(`Terminated ${result.task_id} (${result.previous_state ?? "unknown"} -> ${result.new_state}).`, "");
          break;
        }

        case "dags": {
          const response = await airflow.dags({
            limit: 50,
            ...(argument ? { dag_id_pattern: argument } : {}),
          });
          for (const dag of response.dags) {
            write(
              `${dag.is_paused ? "[paused]  " : "[active]  "}${dag.dag_id.padEnd(44)}${dag.timetable_summary ?? ""}`,
            );
          }
          write(`        ${response.dags.length} of ${response.total_entries} dag(s)`, "");
          break;
        }

        case "trigger": {
          if (!argument) {
            write("Syntax: TRIGGER <dag_id>", "");
            break;
          }
          const dagRun = await airflow.triggerDag(argument);
          write(`Triggered ${argument}: ${dagRun.dag_run_id}`, "");
          break;
        }

        case "pause":
        case "unpause": {
          if (!argument) {
            write(`Syntax: ${command.toUpperCase()} <dag_id>`, "");
            break;
          }
          await airflow.setPaused(argument, command === "pause");
          write(`${argument} is now ${command === "pause" ? "paused" : "active"}.`, "");
          break;
        }

        case "mem": {
          const performance = await kernel.performance();
          write(
            `        ${performance.cpu_running} of ${performance.cpu_total} task slots in use  (${performance.cpu_usage.toFixed(0)}%)`,
            `        ${performance.mem_used_slots} of ${performance.mem_total_slots} pool slots in use  (${performance.mem_usage.toFixed(0)}%)`,
            `        ${performance.queued} queued, ${performance.deferred} deferred`,
            `        ${performance.handles.toLocaleString()} task instances total`,
            "",
          );
          break;
        }

        case "paint":
        case "mspaint": {
          // C:\<dag>\<run>\... - Paint takes whatever of the dag and run the cwd holds.
          const [cwdDag, cwdRun] = cwd.replace(/^C:\/?/u, "").split("/");
          const dagId = argument || cwdDag;
          if (!dagId) {
            write("Syntax: PAINT <dag_id>   (or CD into a dag folder first)", "");
            break;
          }
          desktop.openApp("paint", argument ? { dagId } : { dagId, runId: cwdRun });
          break;
        }

        case "start": {
          const app = {
            control: "control",
            events: "events",
            explorer: "explorer",
            paint: "paint",
            taskmgr: "taskmgr",
          }[argument.toLowerCase()];
          if (!app) {
            write(`Unknown app '${argument}'. Try: taskmgr, explorer, control, events, paint.`, "");
            break;
          }
          desktop.openApp(app, app === "explorer" ? { path: cwd } : {});
          break;
        }

        default:
          write(
            `'${head}' is not recognized as an internal or external command,`,
            "operable program or batch file.",
            "",
          );
      }
    } catch (cause) {
      write(cause instanceof Error ? cause.message : String(cause), "");
    }
  };

  const submit = async () => {
    const raw = input;
    setInput("");
    setBusy(true);
    try {
      await run(raw);
    } finally {
      setBusy(false);
      field.current?.focus();
    }
  };

  return (
    <button
      className="aos-grow aos-scroll aos-mono"
      onClick={() => field.current?.focus()}
      ref={scroller as never}
      style={{
        background: "#000",
        border: "none",
        color: "#c0c0c0",
        cursor: "text",
        display: "block",
        padding: "4px 6px",
        textAlign: "left",
        userSelect: "text",
        width: "100%",
      }}
      type="button"
    >
      {lines.map((line) => (
        <div key={line.id} style={{ minHeight: "1.2em", whiteSpace: "pre-wrap" }}>
          {line.text}
        </div>
      ))}

      <div className="aos-row" style={{ gap: 0 }}>
        <span style={{ whiteSpace: "pre" }}>{prompt}</span>
        <input
          disabled={busy}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
            else if (event.key === "ArrowUp") {
              event.preventDefault();
              const index = historyIndex < 0 ? history.length - 1 : Math.max(historyIndex - 1, 0);
              const entry = history[index];
              if (entry !== undefined) {
                setHistoryIndex(index);
                setInput(entry);
              }
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              const index = historyIndex < 0 ? -1 : historyIndex + 1;
              const entry = index < 0 ? undefined : history[index];
              if (entry === undefined) {
                setHistoryIndex(-1);
                setInput("");
              } else {
                setHistoryIndex(index);
                setInput(entry);
              }
            }
          }}
          ref={field}
          style={{
            background: "transparent",
            border: "none",
            color: "inherit",
            flex: 1,
            font: "inherit",
            outline: "none",
            padding: 0,
          }}
          type="text"
          value={input}
        />
      </div>
    </button>
  );
}

/** Resolve a DOS-ish path against the current directory. */
function resolve(cwd: string, argument: string): string {
  const raw = argument.trim().replaceAll("\\", "/");
  if (!raw || raw === ".") return cwd;
  if (/^c:/iu.test(raw)) return `C:${raw.slice(2).replace(/^\/+/u, "") ? `/${raw.slice(2).replace(/^\/+/u, "")}` : ""}`;

  const segments = cwd.split("/");
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length > 1) segments.pop();
    } else segments.push(part);
  }
  return segments.join("/");
}
