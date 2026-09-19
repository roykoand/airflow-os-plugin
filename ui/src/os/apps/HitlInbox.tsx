import { useEffect, useMemo, useState } from "react";

import { airflow, kernel } from "../api/client";
import type { HitlRequest } from "../api/types";
import { Icon } from "../components/Icon";
import {
  Button,
  Column,
  ErrorNotice,
  Field,
  ListView,
  StateDot,
  StatusBar,
  Toolbar,
  formatWhen,
  useSort,
} from "../components/widgets";
import { usePoll } from "../hooks/usePoll";
import { useDesktop } from "../kernel/desktop";
import { sound } from "../kernel/sound";

/**
 * The Human Input Required inbox.
 *
 * Airflow 3.1's HITL operators park a task until a person answers, which is exactly
 * the shape of a Windows message box: a subject, some body text, and a row of buttons.
 * So that is how they are rendered - the operator's `options` become the buttons, and
 * pressing one resumes the task.
 *
 * Requests carrying `params` cannot be a plain message box, since they are asking for
 * values rather than a decision; those get a small form above the buttons.
 */
export function HitlInbox() {
  const desktop = useDesktop();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAnswered, setShowAnswered] = useState(false);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const { data, error, initial, refresh } = usePoll(() => kernel.hitl(showAnswered), {
    deps: [showAnswered],
    interval: 5000,
  });

  const requests = useMemo(() => data ?? [], [data]);
  const selected = requests.find((row) => row.ti_id === selectedId) ?? requests[0];

  // Keyed on the id, not on `selected`: the 5s poll hands back a new object every
  // time, and depending on that would wipe half-typed input on every refresh.
  useEffect(() => {
    if (!selected) return;
    setInputs(
      Object.fromEntries(
        Object.entries(selected.params).map(([key, value]) => [key, paramToText(value)]),
      ),
    );
    setChecked(selected.defaults ?? []);
  }, [selected?.ti_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const columns: Column<HitlRequest>[] = [
    {
      key: "subject",
      label: "Subject",
      render: (row) => (
        <>
          <StateDot state={row.responded_at === null ? "queued" : "success"} />
          {row.subject}
        </>
      ),
      sort: (row) => row.subject,
    },
    { key: "dag", label: "Dag", render: (row) => row.dag_id, sort: (row) => row.dag_id },
    { key: "task", label: "Task", render: (row) => row.task_id, sort: (row) => row.task_id },
    {
      key: "created",
      label: "Requested",
      render: (row) => formatWhen(row.created_at),
      sort: (row) => row.created_at ?? "",
    },
    {
      key: "answer",
      label: "Answer",
      render: (row) => (row.chosen_options ?? []).join(", "),
      sort: (row) => (row.chosen_options ?? []).join(", "),
    },
  ];
  const sorter = useSort(columns, "created", "desc");

  const answer = async (request: HitlRequest, chosen: string[]) => {
    setBusy(true);
    try {
      await airflow.respondHitl(request.dag_id, request.run_id, request.task_id, request.map_index, {
        chosen_options: chosen,
        params_input: Object.fromEntries(
          Object.entries(inputs).map(([key, value]) => [key, coerce(value, request.params[key])]),
        ),
      });
      sound.play("tada");
      refresh();
      await desktop.messageBox({
        detail: `${request.dag_id} · ${request.task_id} will now resume.`,
        icon: "info",
        text: `Answered "${request.subject}" with ${chosen.join(", ")}.`,
        title: "Human Input Required",
      });
    } catch (cause) {
      await desktop.messageBox({
        detail: cause instanceof Error ? cause.message : String(cause),
        icon: "error",
        text: "That answer was not accepted.",
        title: "Unable to Respond",
      });
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorNotice error={error} />;

  const pending = requests.filter((row) => row.responded_at === null).length;

  return (
    <>
      <ListView
        columns={columns}
        empty={initial ? "Checking for requests…" : "Nothing is waiting on you."}
        onSelect={(row) => setSelectedId(row.ti_id)}
        rowKey={(row) => row.ti_id}
        rows={sorter.apply(requests)}
        selectedKey={selected?.ti_id ?? null}
        {...sorter}
      />

      {selected ? (
        <div
          className="aos-panel"
          style={{ flex: "none", marginTop: 4, maxHeight: 260, overflow: "auto", padding: 10 }}
        >
          <div className="aos-row" style={{ alignItems: "flex-start", gap: 10 }}>
            <Icon name="question" size={32} />
            <div className="aos-grow" style={{ userSelect: "text" }}>
              <div style={{ fontWeight: "bold", marginBottom: 4 }}>{selected.subject}</div>
              {selected.body === null ? null : (
                <div style={{ lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{selected.body}</div>
              )}
              <div style={{ color: "var(--text-disabled)", marginTop: 6 }}>
                {selected.dag_id} · {selected.task_id} · requested {formatWhen(selected.created_at)}
                {selected.assignees.length > 0
                  ? ` · for ${selected.assignees.map((user) => user.name).join(", ")}`
                  : ""}
              </div>
            </div>
          </div>

          {Object.keys(selected.params).length > 0 ? (
            <fieldset className="aos-groupbox" style={{ marginTop: 10 }}>
              <legend>Required information</legend>
              {Object.keys(selected.params).map((key) => (
                <div className="aos-row" key={key} style={{ marginBottom: 4 }}>
                  <span style={{ width: 140 }}>{key}</span>
                  <Field
                    disabled={selected.responded_at !== null}
                    onChange={(value) => setInputs((previous) => ({ ...previous, [key]: value }))}
                    style={{ flex: 1 }}
                    value={inputs[key] ?? ""}
                  />
                </div>
              ))}
            </fieldset>
          ) : null}

          {selected.responded_at === null && selected.multiple ? (
            <fieldset className="aos-groupbox" style={{ marginTop: 10 }}>
              <legend>Choose one or more</legend>
              {selected.options.map((option) => (
                <label className="aos-row" key={option} style={{ gap: 5 }}>
                  <input
                    checked={checked.includes(option)}
                    onChange={(event) =>
                      setChecked((previous) =>
                        event.target.checked
                          ? [...previous, option]
                          : previous.filter((entry) => entry !== option),
                      )
                    }
                    type="checkbox"
                  />
                  {option}
                </label>
              ))}
            </fieldset>
          ) : null}

          <div className="aos-row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
            {selected.responded_at !== null ? null : selected.multiple ? (
              // The API requires at least one option, so OK stays disabled until then.
              <Button disabled={busy || checked.length === 0} onClick={() => void answer(selected, checked)}>
                OK
              </Button>
            ) : (
              selected.options.map((option) => (
                <Button disabled={busy} key={option} onClick={() => void answer(selected, [option])}>
                  {option}
                </Button>
              ))
            )}
            {selected.responded_at === null ? null : (
              <span style={{ color: "var(--text-disabled)" }}>
                Answered {formatWhen(selected.responded_at)}
                {selected.responded_by === null ? "" : ` by ${selected.responded_by}`} with{" "}
                <b>{(selected.chosen_options ?? []).join(", ")}</b>.
              </span>
            )}
          </div>
        </div>
      ) : null}

      <Toolbar>
        <label className="aos-row" style={{ gap: 4 }}>
          <input
            checked={showAnswered}
            onChange={(event) => setShowAnswered(event.target.checked)}
            type="checkbox"
          />
          Show answered requests
        </label>
        <div className="aos-grow" />
        <Button onClick={refresh} small>
          Refresh
        </Button>
      </Toolbar>

      <StatusBar
        panes={[
          pending === 0 ? "Nothing is waiting on you." : `${pending} request(s) awaiting input`,
          selected ? `Run ${selected.run_id}` : "",
        ]}
      />
    </>
  );
}

/** Params arrive as Airflow Param objects or bare values; show something editable. */
function paramToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "value" in (value as Record<string, unknown>)) {
    return paramToText((value as Record<string, unknown>).value);
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** Send back the type the param started as, so a number stays a number. */
function coerce(text: string, original: unknown): unknown {
  const seed =
    original !== null && typeof original === "object" && "value" in (original as Record<string, unknown>)
      ? (original as Record<string, unknown>).value
      : original;

  if (typeof seed === "number") {
    const parsed = Number(text);
    return Number.isNaN(parsed) ? text : parsed;
  }
  if (typeof seed === "boolean") return text === "true";
  if (typeof seed === "object" && seed !== null) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
