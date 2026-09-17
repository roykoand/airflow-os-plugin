import { describe, expect, it } from "vitest";

import type { DagTask, TaskInstance } from "../api/types";
import { COLOURS, colourKey, encodeBmp, layout, summarise } from "./paintGraph";

function task(id: string, downstream: string[] = [], extra: Partial<DagTask> = {}): DagTask {
  return {
    doc_md: null,
    downstream_task_ids: downstream,
    is_mapped: false,
    operator_name: "PythonOperator",
    task_display_name: null,
    task_id: id,
    trigger_rule: "all_success",
    ui_color: null,
    ...extra,
  };
}

function instance(taskId: string, state: string | null, mapIndex = -1): TaskInstance {
  return {
    dag_id: "d",
    dag_run_id: "r",
    duration: 1,
    end_date: null,
    map_index: mapIndex,
    note: null,
    operator: null,
    start_date: null,
    state,
    task_id: taskId,
    try_number: 1,
  };
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("layout", () => {
  it("puts a diamond into three layers with the join last", () => {
    const picture = layout([task("a", ["b", "c"]), task("b", ["d"]), task("c", ["d"]), task("d")], "lr");
    const layer = Object.fromEntries(picture.nodes.map((node) => [node.id, node.layer]));
    expect(layer).toEqual({ a: 0, b: 1, c: 1, d: 2 });
    expect(picture.layers).toBe(3);
    expect(picture.edges).toHaveLength(4);
  });

  it("uses the longest path, so a shortcut edge does not pull a task forward", () => {
    // a -> b -> c and a -> c: c must sit after b, not beside it.
    const picture = layout([task("a", ["b", "c"]), task("b", ["c"]), task("c")], "lr");
    const layer = Object.fromEntries(picture.nodes.map((node) => [node.id, node.layer]));
    expect(layer.c).toBe(2);
  });

  it("never overlaps boxes and always points edges deeper", () => {
    const tasks = [
      task("extract", ["clean", "validate", "profile"]),
      task("clean", ["join"]),
      task("validate", ["join"]),
      task("profile"),
      task("join", ["load_a", "load_b"]),
      task("load_a", ["notify"]),
      task("load_b", ["notify"]),
      task("notify"),
      task("lonely"),
    ];
    for (const orientation of ["lr", "tb"] as const) {
      const picture = layout(tasks, orientation);
      const byId = new Map(picture.nodes.map((node) => [node.id, node]));
      for (const a of picture.nodes) for (const b of picture.nodes) if (a !== b) expect(overlaps(a, b)).toBe(false);
      for (const edge of picture.edges) expect(byId.get(edge.to)!.layer).toBeGreaterThan(byId.get(edge.from)!.layer);
      for (const node of picture.nodes) {
        expect(node.x + node.w).toBeLessThanOrEqual(picture.width);
        expect(node.y + node.h).toBeLessThanOrEqual(picture.height);
      }
    }
  });

  it("flips the main axis when rotated", () => {
    const tasks = [task("a", ["b"]), task("b")];
    const lr = layout(tasks, "lr");
    const tb = layout(tasks, "tb");
    const [a1, b1] = lr.nodes.sort((p, q) => p.layer - q.layer);
    const [a2, b2] = tb.nodes.sort((p, q) => p.layer - q.layer);
    expect(b1!.x).toBeGreaterThan(a1!.x);
    expect(b1!.y).toBe(a1!.y);
    expect(b2!.y).toBeGreaterThan(a2!.y);
    expect(b2!.x).toBe(a2!.x);
  });

  it("ignores downstream ids that are not in the task list", () => {
    const picture = layout([task("a", ["ghost"])], "lr");
    expect(picture.edges).toEqual([]);
    expect(picture.nodes).toHaveLength(1);
  });

  it("handles an empty dag", () => {
    const picture = layout([], "lr");
    expect(picture.nodes).toEqual([]);
    expect(picture.width).toBeGreaterThan(0);
  });

  it("prefers the display name for the label and keeps mapped-ness", () => {
    const [node] = layout([task("t", [], { is_mapped: true, task_display_name: "Pretty" })], "lr").nodes;
    expect(node!.label).toBe("Pretty");
    expect(node!.mapped).toBe(true);
  });
});

describe("colourKey", () => {
  it("maps every Airflow state to a colour in the box", () => {
    const keys = new Set(COLOURS.map((colour) => colour.key));
    for (const state of [
      "success",
      "failed",
      "running",
      "queued",
      "scheduled",
      "deferred",
      "skipped",
      "upstream_failed",
      "up_for_retry",
      "up_for_reschedule",
      "restarting",
      "removed",
      null,
      undefined,
      "something_new",
    ]) {
      expect(keys.has(colourKey(state))).toBe(true);
    }
    expect(colourKey("scheduled")).toBe("queued");
    expect(colourKey("restarting")).toBe("running");
    expect(colourKey(null)).toBe("none");
  });

  it("only offers the states a person may set as paintable", () => {
    expect(COLOURS.filter((colour) => colour.paintable).map((colour) => colour.key)).toEqual([
      "success",
      "failed",
      "skipped",
      "none",
    ]);
  });
});

describe("summarise", () => {
  it("groups instances by task and picks the most alarming state for a mapped task", () => {
    const summaries = summarise([
      instance("shards", "success", 0),
      instance("shards", "failed", 1),
      instance("shards", "running", 2),
      instance("single", "success"),
    ]);
    expect(summaries.get("shards")!.instances).toHaveLength(3);
    expect(summaries.get("shards")!.state).toBe("running");
    expect(summaries.get("single")!.state).toBe("success");
    expect(summaries.has("missing")).toBe(false);
  });

  it("treats a task whose instances all lack a state as unpainted", () => {
    expect(summarise([instance("t", null)]).get("t")!.state).toBeNull();
  });
});

describe("encodeBmp", () => {
  const image = (width: number, height: number, rgb: [number, number, number]) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) data.set([...rgb, 255], i * 4);
    return { colorSpace: "srgb", data, height, width } as ImageData;
  };

  it("writes a valid 24-bit header with 4-byte padded rows", async () => {
    const blob = encodeBmp(image(3, 2, [255, 0, 0]));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const rowSize = 12; // 3 px * 3 bytes = 9, padded to 12
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe("BM");
    expect(view.getUint32(2, true)).toBe(54 + rowSize * 2);
    expect(view.getUint32(10, true)).toBe(54);
    expect(view.getInt32(18, true)).toBe(3);
    expect(view.getInt32(22, true)).toBe(2);
    expect(view.getUint16(28, true)).toBe(24);
    expect(blob.size).toBe(54 + rowSize * 2);
    // Pixels are BGR: red becomes 00 00 FF.
    expect([bytes[54], bytes[55], bytes[56]]).toEqual([0, 0, 255]);
    expect(blob.type).toBe("image/bmp");
  });
});
