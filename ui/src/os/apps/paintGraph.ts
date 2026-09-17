import type { DagTask, TaskInstance } from "../api/types";

/*
 * The pure half of Paint: the state palette, the graph layout, the per-task state
 * roll-up and the bitmap encoder. Nothing here touches React or the DOM beyond a
 * canvas used to measure text, so all of it is unit-testable.
 */

/* ------------------------------------------------------------------ colours -- */

/**
 * The colour box is the state legend. Canvas cannot read CSS variables, so the
 * theme's state palette is repeated here; keep it in step with win95.css.
 */
export interface Colour {
  key: string;
  label: string;
  hex: string;
  /** Drawn as a 50% dither with white, the way Paint faked colours it did not have. */
  dither?: boolean;
  /** Whether Fill may apply it: the states Airflow lets a person set. */
  paintable: boolean;
}

export const COLOURS: Colour[] = [
  { hex: "#008000", key: "success", label: "success", paintable: true },
  { hex: "#a80000", key: "failed", label: "failed", paintable: true },
  { hex: "#b06000", key: "skipped", label: "skipped", paintable: true },
  { hex: "#ffffff", key: "none", label: "no status (erases the task instance)", paintable: true },
  { hex: "#00a2e8", key: "running", label: "running", paintable: false },
  { hex: "#808000", key: "queued", label: "queued / scheduled", paintable: false },
  { hex: "#6a3ea1", key: "deferred", label: "deferred", paintable: false },
  { dither: true, hex: "#a80000", key: "upstream_failed", label: "upstream_failed", paintable: false },
  { dither: true, hex: "#808000", key: "up_for_retry", label: "up_for_retry / up_for_reschedule", paintable: false },
  { hex: "#606060", key: "removed", label: "removed", paintable: false },
];

export const COLOUR_BY_KEY = new Map(COLOURS.map((colour) => [colour.key, colour]));

export function colourKey(state: string | null | undefined): string {
  switch (state) {
    case "scheduled":
      return "queued";
    case "up_for_reschedule":
      return "up_for_retry";
    case "restarting":
      return "running";
    case undefined:
    case null:
      return "none";
    default:
      return COLOUR_BY_KEY.has(state) ? state : "none";
  }
}

/** Which state wins when a mapped task's instances disagree: the most alarming one. */
export const STATE_RANK = [
  "running",
  "restarting",
  "failed",
  "upstream_failed",
  "up_for_retry",
  "up_for_reschedule",
  "queued",
  "scheduled",
  "deferred",
  "skipped",
  "removed",
  "success",
];


/* ------------------------------------------------------------------- layout -- */

export type Orientation = "lr" | "tb";

export interface Node {
  id: string;
  label: string;
  layer: number;
  mapped: boolean;
  triggerRule: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Edge {
  from: string;
  to: string;
}

export interface Picture {
  nodes: Node[];
  edges: Edge[];
  width: number;
  height: number;
  layers: number;
}

export const NODE_H = 24;
export const GAP_MAIN = 44;
export const GAP_CROSS = 14;
export const PAD = 16;
export const FONT = '11px "MS Sans Serif", "Microsoft Sans Serif", Tahoma, Geneva, Verdana, sans-serif';

const measurer = document.createElement("canvas").getContext("2d");

function measure(text: string): number {
  if (!measurer) return text.length * 6;
  measurer.font = FONT;
  return measurer.measureText(text).width;
}

/**
 * Longest-path layering, then a few barycenter sweeps to untangle each layer.
 * Not Sugiyama, but a dag with a few dozen tasks comes out readable, and the
 * point of Paint is that the picture is honest, not that it is optimal.
 */
export function layout(tasks: DagTask[], orientation: Orientation): Picture {
  const known = new Set(tasks.map((task) => task.task_id));
  const upstream = new Map<string, string[]>(tasks.map((task) => [task.task_id, []]));
  const edges: Edge[] = [];
  for (const task of tasks) {
    for (const downstream of task.downstream_task_ids) {
      if (!known.has(downstream)) continue;
      edges.push({ from: task.task_id, to: downstream });
      upstream.get(downstream)?.push(task.task_id);
    }
  }

  // Kahn's algorithm assigns each task the layer after its deepest upstream.
  const layerOf = new Map<string, number>();
  const pending = new Map(tasks.map((task) => [task.task_id, upstream.get(task.task_id)?.length ?? 0]));
  let frontier = tasks.filter((task) => pending.get(task.task_id) === 0).map((task) => task.task_id);
  frontier.forEach((id) => layerOf.set(id, 0));
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const task = tasks.find((entry) => entry.task_id === id);
      for (const downstream of task?.downstream_task_ids ?? []) {
        if (!known.has(downstream)) continue;
        layerOf.set(downstream, Math.max(layerOf.get(downstream) ?? 0, (layerOf.get(id) ?? 0) + 1));
        const remaining = (pending.get(downstream) ?? 1) - 1;
        pending.set(downstream, remaining);
        if (remaining === 0) next.push(downstream);
      }
    }
    frontier = next;
  }
  // A cycle cannot exist in a dag, but a partial listing could leave stragglers.
  tasks.forEach((task) => layerOf.has(task.task_id) || layerOf.set(task.task_id, 0));

  const layerCount = Math.max(0, ...[...layerOf.values()]) + 1;
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  [...tasks]
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .forEach((task) => layers[layerOf.get(task.task_id) ?? 0]?.push(task.task_id));

  // Barycenter ordering: put each task near the average position of its neighbours.
  const position = new Map<string, number>();
  const reindex = () => layers.forEach((layer) => layer.forEach((id, index) => position.set(id, index)));
  reindex();
  const downstreamOf = new Map(tasks.map((task) => [task.task_id, task.downstream_task_ids.filter((id) => known.has(id))]));
  for (let sweep = 0; sweep < 4; sweep += 1) {
    const forward = sweep % 2 === 0;
    for (let index = 1; index < layers.length; index += 1) {
      const layerIndex = forward ? index : layers.length - 1 - index;
      const neighbours = (id: string) => (forward ? upstream.get(id) : downstreamOf.get(id)) ?? [];
      const bary = (id: string) => {
        const around = neighbours(id);
        if (around.length === 0) return position.get(id) ?? 0;
        return around.reduce((sum, other) => sum + (position.get(other) ?? 0), 0) / around.length;
      };
      layers[layerIndex]?.sort((a, b) => bary(a) - bary(b) || a.localeCompare(b));
      reindex();
    }
  }

  // Sizes: every box in a layer shares the widest label, so edges land in columns.
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  const labelOf = (task: DagTask) => task.task_display_name || task.task_id;
  const widthOf = (id: string) => Math.min(200, Math.max(72, Math.ceil(measure(labelOf(byId.get(id) as DagTask))) + 16));
  const layerWidths = layers.map((layer) => Math.max(72, ...layer.map(widthOf)));
  const widest = Math.max(72, ...layerWidths);
  const deepest = Math.max(1, ...layers.map((layer) => layer.length));

  const nodes: Node[] = [];
  let mainOffset = PAD;
  layers.forEach((layer, layerIndex) => {
    const crossExtent = orientation === "lr" ? NODE_H + GAP_CROSS : widest + GAP_CROSS;
    const centering = Math.round(((deepest - layer.length) * crossExtent) / 2);
    layer.forEach((id, order) => {
      const task = byId.get(id) as DagTask;
      const cross = PAD + centering + order * crossExtent;
      const w = orientation === "lr" ? (layerWidths[layerIndex] ?? widest) : widest;
      nodes.push({
        h: NODE_H,
        id,
        label: labelOf(task),
        layer: layerIndex,
        mapped: task.is_mapped,
        triggerRule: task.trigger_rule,
        w,
        x: orientation === "lr" ? mainOffset : cross,
        y: orientation === "lr" ? cross : mainOffset,
      });
    });
    mainOffset += (orientation === "lr" ? (layerWidths[layerIndex] ?? widest) : NODE_H) + GAP_MAIN;
  });

  const width = Math.max(PAD * 2, ...nodes.map((node) => node.x + node.w)) + PAD;
  const height = Math.max(PAD * 2, ...nodes.map((node) => node.y + node.h)) + PAD;
  return { edges, height, layers: layerCount, nodes, width };
}


/* ------------------------------------------------------------------ roll-up -- */

export interface Summary {
  state: string | null;
  instances: TaskInstance[];
  latest: TaskInstance | null;
}

export function summarise(instances: TaskInstance[]): Map<string, Summary> {
  const byTask = new Map<string, TaskInstance[]>();
  for (const instance of instances) {
    const list = byTask.get(instance.task_id) ?? [];
    list.push(instance);
    byTask.set(instance.task_id, list);
  }
  const summaries = new Map<string, Summary>();
  for (const [taskId, list] of byTask) {
    const ranked = [...list].sort((a, b) => STATE_RANK.indexOf(a.state ?? "") - STATE_RANK.indexOf(b.state ?? ""));
    const worst = ranked.find((instance) => instance.state !== null) ?? null;
    summaries.set(taskId, {
      instances: list,
      latest: worst ?? list[0] ?? null,
      state: worst?.state ?? null,
    });
  }
  return summaries;
}


/* ------------------------------------------------------------------- bitmap -- */
/** The 24-bit .bmp Paint would have saved. Bottom-up rows, BGR, padded to 4 bytes. */
export function encodeBmp(image: ImageData): Blob {
  const rowSize = Math.floor((24 * image.width + 31) / 32) * 4;
  const pixelBytes = rowSize * image.height;
  const buffer = new ArrayBuffer(54 + pixelBytes);
  const view = new DataView(buffer);
  view.setUint8(0, 0x42);
  view.setUint8(1, 0x4d);
  view.setUint32(2, 54 + pixelBytes, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, image.width, true);
  view.setInt32(22, image.height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelBytes, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);
  const bytes = new Uint8Array(buffer, 54);
  for (let y = 0; y < image.height; y += 1) {
    const source = (image.height - 1 - y) * image.width * 4;
    const target = y * rowSize;
    for (let x = 0; x < image.width; x += 1) {
      bytes[target + x * 3] = image.data[source + x * 4 + 2] ?? 0;
      bytes[target + x * 3 + 1] = image.data[source + x * 4 + 1] ?? 0;
      bytes[target + x * 3 + 2] = image.data[source + x * 4] ?? 0;
    }
  }
  return new Blob([buffer], { type: "image/bmp" });
}

