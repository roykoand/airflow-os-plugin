import { useCallback, useEffect, useState } from "react";

import { kernel } from "../api/client";
import type { FsEntry } from "../api/types";
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
import type { AppProps } from "../registry";

/**
 * Explorer over the metadata database.
 *
 *   C:\<dag_id>\<run_id>\<task_id>\{stdout.log, xcom\, details.json}
 *
 * Folders are dags, dag runs and task instances; files are logs, XCom values and
 * rendered properties. Double-clicking a file opens it in Notepad.
 */
export function Explorer({ props, windowId }: AppProps) {
  const desktop = useDesktop();
  const initialPath = typeof props.path === "string" ? props.path : "C:";
  const [path, setPath] = useState(initialPath);
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const { data, error, initial, refresh } = usePoll(() => kernel.list(path), {
    deps: [path],
    interval: 8000,
  });

  const navigate = useCallback(
    (next: string) => {
      setHistory((stack) => [...stack, path]);
      setPath(next);
      setSelected(null);
    },
    [path],
  );

  useEffect(() => {
    desktop.setTitle(windowId, `${data?.title ?? path} - Exploring`);
  }, [data?.title, path, desktop, windowId]);

  const open = (entry: FsEntry) => {
    if (entry.kind === "file") {
      if (entry.name.endsWith(".log")) {
        // The listing carries task_id, map_index and try_number, because parsing them
        // back out of the path is ambiguous: task ids may contain dots, and the newest
        // attempt displays as "stdout.log" while its path is "stdout.<n>.log".
        const [dagId, runId] = entry.path.replace(/^C:\//u, "").split("/");
        desktop.openApp(
          "notepad",
          {
            dagId,
            mapIndex: entry.map_index ?? -1,
            mode: "log",
            runId,
            taskId: entry.task_id,
            tryNumber: entry.try_number ?? 1,
          },
          { title: `${entry.name} - Notepad` },
        );
      } else {
        desktop.openApp("notepad", { mode: "file", path: entry.path }, { title: `${entry.name} - Notepad` });
      }
      return;
    }
    navigate(entry.path);
  };

  const columns: Column<FsEntry>[] = [
    {
      key: "name",
      label: "Name",
      render: (entry) => (
        <span className="aos-row" style={{ gap: 5 }}>
          <Icon name={iconFor(entry)} size={16} />
          {entry.name}
        </span>
      ),
      sort: (entry) => `${entry.kind === "file" ? "1" : "0"}${entry.name}`,
    },
    {
      key: "state",
      label: "Status",
      render: (entry) =>
        entry.state ? (
          <>
            <StateDot state={entry.state} />
            {entry.state}
          </>
        ) : (
          ""
        ),
      sort: (entry) => entry.state ?? "",
    },
    {
      key: "modified",
      label: "Modified",
      render: (entry) => formatWhen(entry.modified),
      sort: (entry) => entry.modified ?? "",
    },
    { key: "detail", label: "Details", render: (entry) => entry.detail ?? "", sort: (entry) => entry.detail ?? "" },
  ];

  const sorter = useSort(columns, "name");
  const entries = data?.entries ?? [];
  const current = entries.find((entry) => entry.path === selected);

  // Inside C:\<dag>[\<run>] the graph of this folder can be opened in Paint.
  const [folderDag, folderRun] = path.replace(/^C:\/?/u, "").split("/");

  if (error) return <ErrorNotice error={error} />;

  return (
    <>
      <Toolbar>
        <Button
          disabled={history.length === 0}
          onClick={() => {
            const previous = history.at(-1);
            if (previous === undefined) return;
            setHistory((stack) => stack.slice(0, -1));
            setPath(previous);
            setSelected(null);
          }}
          small
          title="Back"
        >
          ← Back
        </Button>
        <Button
          disabled={!data?.parent}
          onClick={() => (data?.parent ? navigate(data.parent) : undefined)}
          small
          title="Up one level"
        >
          ↑ Up
        </Button>
        <Button onClick={refresh} small>
          Refresh
        </Button>
        {folderDag ? (
          <Button
            onClick={() => desktop.openApp("paint", { dagId: folderDag, runId: folderRun })}
            small
            title="Open this dag's graph in Paint"
          >
            Paint
          </Button>
        ) : null}
        <span style={{ marginLeft: 6 }}>Address:</span>
        <div className="aos-well aos-grow aos-row" style={{ gap: 5, minWidth: 0, padding: "3px 5px" }}>
          <Icon name="folder-open" size={14} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {data?.title ?? path.replaceAll("/", "\\")}
          </span>
        </div>
      </Toolbar>

      <ListView
        columns={columns}
        empty={initial ? "Reading folder…" : "This folder is empty."}
        onActivate={open}
        onSelect={(entry) => setSelected(entry.path)}
        rowKey={(entry) => entry.path}
        rows={sorter.apply(entries)}
        selectedKey={selected}
        {...sorter}
      />

      <StatusBar
        panes={[
          `${entries.length} object(s)`,
          current ? current.detail ?? current.kind : "",
        ]}
      />
    </>
  );
}

function iconFor(entry: FsEntry): string {
  if (entry.icon.startsWith("folder-")) {
    // Folder icons carry the run/task state; the shell only draws two folder sprites,
    // so the state is shown by the status dot instead.
    return "folder";
  }
  if (entry.icon === "drive-hdd") return "drive-hdd";
  if (entry.icon === "file-py") return "file-py";
  if (entry.icon === "file-json") return "file-json";
  if (entry.icon === "file-log") return "file-log";
  return "file";
}
