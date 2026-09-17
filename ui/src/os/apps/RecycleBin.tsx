import { useState } from "react";

import { kernel } from "../api/client";
import type { RecycledItem } from "../api/types";
import { Icon } from "../components/Icon";
import {
  Button,
  Column,
  ErrorNotice,
  ListView,
  StatusBar,
  Toolbar,
  formatWhen,
  useSort,
} from "../components/widgets";
import { usePoll } from "../hooks/usePoll";
import { useDesktop } from "../kernel/desktop";

/**
 * The Recycle Bin.
 *
 * Airflow already behaves like one and nobody notices. Deleting a dag file does not
 * drop the record - the scheduler sets `is_stale` and keeps everything: the runs, the
 * logs, the XComs. Put the file back and it all comes home. Task instances get the
 * same treatment: a task removed from a dag leaves its old instances in state
 * `removed` rather than deleting them.
 *
 * So this is not a metaphor stretched over Airflow. It is the name for something
 * Airflow was already doing.
 */
export function RecycleBin() {
  const desktop = useDesktop();
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, error, initial, refresh } = usePoll(kernel.recycleBin, { interval: 15_000 });
  const items = data ?? [];
  const current = items.find((item) => item.key === selected);
  const staleDags = items.filter((item) => item.kind === "dag");

  const columns: Column<RecycledItem>[] = [
    {
      key: "name",
      label: "Name",
      render: (item) => (
        <span className="aos-row" style={{ gap: 5 }}>
          <Icon name={item.kind === "dag" ? "folder-broken" : "file-skip"} size={16} />
          {item.name}
        </span>
      ),
      sort: (item) => item.name,
    },
    {
      key: "kind",
      label: "Original Location",
      render: (item) => (item.kind === "dag" ? "C:\\" : `C:\\${item.dag_id}\\${item.run_id ?? ""}`),
      sort: (item) => item.dag_id,
    },
    {
      key: "kindLabel",
      label: "Type",
      render: (item) => (item.kind === "dag" ? "Dag (stale)" : "Task instance (removed)"),
      sort: (item) => item.kind,
    },
    {
      key: "deleted",
      label: "Date Deleted",
      render: (item) => formatWhen(item.deleted_at),
      sort: (item) => item.deleted_at ?? "",
    },
  ];
  const sorter = useSort(columns, "deleted", "desc");

  const restore = async (item: RecycledItem) => {
    // Be honest: nothing the desktop can do puts a deleted file back.
    await desktop.messageBox({
      detail:
        item.kind === "dag"
          ? `${item.dag_id} went stale because its file is no longer in the dag bundle. ` +
            `Restore the file and the dag-processor will bring it back, with its history intact.`
          : `${item.task_id} no longer exists in ${item.dag_id}. Add the task back to the dag ` +
            `and its old instances stop being marked removed.`,
      icon: "warning",
      text: "Airflow OS cannot restore this item.",
      title: "Restore",
    });
  };

  const purge = async (item: RecycledItem) => {
    const answer = await desktop.messageBox({
      buttons: [
        { label: "Yes", primary: true, value: "yes" },
        { label: "No", value: "no" },
      ],
      detail: "Every dag run, task instance, log reference and XCom belonging to it goes too.",
      icon: "warning",
      text: `Are you sure you want to permanently delete ${item.dag_id}?`,
      title: "Confirm File Delete",
    });
    if (answer !== "yes") return;

    setBusy(true);
    try {
      await kernel.purgeDag(item.dag_id);
      refresh();
    } catch (cause) {
      await desktop.messageBox({
        detail: cause instanceof Error ? cause.message : String(cause),
        icon: "error",
        text: "That dag could not be deleted.",
        title: "Recycle Bin",
      });
    } finally {
      setBusy(false);
    }
  };

  const empty = async () => {
    if (staleDags.length === 0) return;
    const answer = await desktop.messageBox({
      buttons: [
        { label: "Yes", primary: true, value: "yes" },
        { label: "No", value: "no" },
      ],
      detail:
        "Removed task instances are not deleted - they belong to dags that still exist. " +
        "Only the stale dag records are dropped.",
      icon: "warning",
      text: `Permanently delete ${staleDags.length} stale dag${staleDags.length === 1 ? "" : "s"}?`,
      title: "Confirm Multiple File Delete",
    });
    if (answer !== "yes") return;

    setBusy(true);
    const failures: string[] = [];
    for (const item of staleDags) {
      try {
        await kernel.purgeDag(item.dag_id);
      } catch {
        failures.push(item.dag_id);
      }
    }
    setBusy(false);
    refresh();
    if (failures.length > 0) {
      await desktop.messageBox({
        detail: failures.join(", "),
        icon: "error",
        text: `${failures.length} dag(s) could not be deleted.`,
        title: "Recycle Bin",
      });
    }
  };

  if (error) return <ErrorNotice error={error} />;

  return (
    <>
      <ListView
        columns={columns}
        empty={initial ? "Reading…" : "The Recycle Bin is empty."}
        onActivate={(item) =>
          item.kind === "task" && item.run_id
            ? desktop.openApp("explorer", { path: `C:/${item.dag_id}/${item.run_id}` })
            : undefined
        }
        onSelect={(item) => setSelected(item.key)}
        rowKey={(item) => item.key}
        rows={sorter.apply(items)}
        selectedKey={selected}
        {...sorter}
      />

      <Toolbar>
        <Button disabled={!current || busy} onClick={() => (current ? void restore(current) : undefined)}>
          Restore
        </Button>
        <Button
          disabled={!current || current.kind !== "dag" || busy}
          onClick={() => (current ? void purge(current) : undefined)}
        >
          Delete
        </Button>
        <div className="aos-grow" />
        <Button disabled={staleDags.length === 0 || busy} onClick={() => void empty()}>
          Empty Recycle Bin
        </Button>
      </Toolbar>

      <StatusBar
        panes={[
          `${items.length} object(s)`,
          `${staleDags.length} stale dag(s), ${items.length - staleDags.length} removed task(s)`,
        ]}
      />
    </>
  );
}
