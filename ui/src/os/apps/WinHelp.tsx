import { useMemo, useState } from "react";

import { airflow, basePath } from "../api/client";
import { Icon } from "../components/Icon";
import { renderMarkdown } from "../components/markdown";
import { Button, ErrorNotice, Field, StatusBar, Toolbar, formatWhen } from "../components/widgets";
import { usePoll } from "../hooks/usePoll";
import { useDesktop } from "../kernel/desktop";

/*
 * Airflow Help: the WinHelp viewer, over documentation Airflow already has.
 *
 * Dags and tasks carry `doc_md`, and nothing else in the desktop surfaces it. A dag is
 * a book; its tasks are the pages inside. Selecting one renders its Markdown in the
 * topic pane, the way a .hlp file always did.
 *
 * Task lists are fetched only when a book is opened - there can be hundreds of dags,
 * and asking every one of them for its tasks up front would be an unkind way to say
 * hello.
 */

interface Topic {
  dagId: string;
  taskId?: string;
}

export function WinHelp() {
  const desktop = useDesktop();
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [topic, setTopic] = useState<Topic | null>(null);
  const [history, setHistory] = useState<Topic[]>([]);

  const { data: dagList, error } = usePoll(() => airflow.dags({ limit: 200 }), { interval: 0 });

  const dags = useMemo(() => {
    const rows = dagList?.dags ?? [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (dag) =>
        dag.dag_id.toLowerCase().includes(needle) ||
        (dag.description ?? "").toLowerCase().includes(needle),
    );
  }, [dagList, filter]);

  const { data: tasks } = usePoll(() => (expanded === null ? Promise.resolve(null) : airflow.tasks(expanded)), {
    deps: [expanded],
    interval: 0,
  });

  const { data: details, loading } = usePoll(
    () => (topic === null ? Promise.resolve(null) : airflow.dagDetails(topic.dagId)),
    { deps: [topic?.dagId], interval: 0 },
  );

  const open = (next: Topic) => {
    setHistory((stack) => (topic ? [...stack, topic] : stack));
    setTopic(next);
  };

  const body = useMemo(() => {
    if (topic === null) return null;
    if (topic.taskId === undefined) return details?.doc_md ?? null;
    const task = (tasks?.tasks ?? []).find((entry) => entry.task_id === topic.taskId);
    return task?.doc_md ?? null;
  }, [topic, details, tasks]);

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
            setTopic(previous);
          }}
          small
        >
          ← Back
        </Button>
        <Button
          onClick={() => {
            setTopic(null);
            setHistory([]);
          }}
          small
        >
          Contents
        </Button>
        <Button
          disabled={topic === null}
          onClick={() =>
            topic
              ? desktop.openApp("explorer", { path: `C:/${topic.dagId}` })
              : undefined
          }
          small
        >
          Go to Dag
        </Button>
        <span style={{ marginLeft: 6 }}>Find:</span>
        <Field onChange={setFilter} placeholder="dag id or description" value={filter} />
      </Toolbar>

      <div className="aos-help">
        <div className="aos-help-contents">
          {dags.map((dag) => (
            <div key={dag.dag_id}>
              <button
                className="aos-help-book"
                data-selected={topic?.dagId === dag.dag_id && topic.taskId === undefined}
                onClick={() => {
                  setExpanded((current) => (current === dag.dag_id ? null : dag.dag_id));
                  open({ dagId: dag.dag_id });
                }}
                type="button"
              >
                <Icon name={expanded === dag.dag_id ? "folder-open" : "help"} size={16} />
                <span>{dag.dag_id}</span>
              </button>

              {expanded === dag.dag_id
                ? (tasks?.tasks ?? []).map((task) => (
                    <button
                      className="aos-help-page"
                      data-selected={topic?.taskId === task.task_id}
                      key={task.task_id}
                      onClick={() => open({ dagId: dag.dag_id, taskId: task.task_id })}
                      type="button"
                    >
                      <Icon name={task.doc_md === null ? "file" : "file-log"} size={16} />
                      <span>{task.task_id}</span>
                    </button>
                  ))
                : null}
            </div>
          ))}
          {dags.length === 0 ? (
            <div style={{ color: "var(--text-disabled)", padding: 6 }}>No dag matches that.</div>
          ) : null}
        </div>

        <div className="aos-help-topic">
          {topic === null ? (
            <div className="aos-help-welcome">
              <div className="aos-help-h" style={{ fontSize: 15 }}>
                Airflow Help
              </div>
              <p className="aos-help-p">
                Choose a book on the left to read a dag&apos;s documentation, or open it to read the
                documentation of the tasks inside.
              </p>
              <p className="aos-help-p">
                Topics come from <b>doc_md</b> on your dags and tasks - the docstrings and markdown
                you have already written. Nothing here is authored by Airflow OS.
              </p>
              <p className="aos-help-p" style={{ color: "var(--text-disabled)" }}>
                {dagList?.total_entries ?? 0} dags installed on this machine.
              </p>
            </div>
          ) : loading ? (
            <div style={{ padding: 10 }}>Opening topic…</div>
          ) : (
            <>
              <div className="aos-help-h" style={{ fontSize: 15 }}>
                {topic.taskId ?? topic.dagId}
              </div>
              <div style={{ color: "var(--text-disabled)", marginBottom: 10 }}>
                {topic.taskId === undefined
                  ? `Dag · last parsed ${formatWhen(details?.last_parsed_time ?? null)}`
                  : `Task in ${topic.dagId}`}
              </div>
              {body === null || body.trim().length === 0 ? (
                <p className="aos-help-p" style={{ color: "var(--text-disabled)" }}>
                  This topic has no documentation. Add a <b>doc_md</b> argument, or a docstring on
                  the decorated function, and it will appear here.
                </p>
              ) : (
                renderMarkdown(body)
              )}
            </>
          )}
        </div>
      </div>

      <StatusBar
        panes={[
          topic === null ? "Contents" : `${topic.dagId}${topic.taskId ? ` · ${topic.taskId}` : ""}`,
          basePath() === "" ? "" : basePath(),
        ]}
      />
    </>
  );
}
