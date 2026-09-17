import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { airflow } from "../api/client";
import type { DagRun } from "../api/types";
import { MenuBar, type Menu } from "../components/MenuBar";
import { Button, ErrorNotice, Field, StateDot, StatusBar, formatDuration, formatWhen } from "../components/widgets";
import { usePoll } from "../hooks/usePoll";
import { useDesktop } from "../kernel/desktop";
import type { AppProps } from "../registry";
import {
  COLOURS,
  COLOUR_BY_KEY,
  FONT,
  GAP_MAIN,
  colourKey,
  encodeBmp,
  layout,
  summarise,
  type Colour,
  type Node,
  type Orientation,
  type Picture,
  type Summary,
} from "./paintGraph";

/*
 * Paint, as the graph view.
 *
 * A dag is a picture: tasks are pixel-art boxes laid out in dependency order, edges
 * are 1px lines, and the colour of every box is the state of its task instance in
 * the run being shown. Unpainted (white) means the task has not run yet. Nothing on
 * the canvas is decoration - it is drawn from /dags/{id}/tasks and the run's task
 * instances, and it repaints itself every few seconds.
 *
 * The tools are honest about what Paint can do to Airflow:
 *
 *   Select      pick a task; double-click opens its log in Notepad
 *   Pick Color  read a task's state into the colour box
 *   Fill        paint a task success / failed / skipped, which sets its state
 *   Eraser      clear a task instance, so the scheduler runs it again
 *   Magnifier   zoom
 *
 * Every write goes through the public REST API, as everywhere else on the desktop.
 * The other eleven tools are drawn but disabled: there is no metadata column for a
 * freehand line.
 */

/* -------------------------------------------------------------------- tools -- */

type Tool = "select" | "pick" | "fill" | "erase" | "zoom";

interface ToolDefinition {
  id: string;
  label: string;
  tool?: Tool;
  glyph: string[];
}

/** Paint's sixteen tools, in Paint's order. Five of them mean something here. */
const TOOLS: ToolDefinition[] = [
  { glyph: ["..####..", ".#....#.", "#......#", "#......#", ".#....#.", "..#..#..", "...##...", "...#...."], id: "freeform", label: "Free-Form Select" },
  { glyph: ["#.#.#.#.", "........", "#......#", "........", "#......#", "........", "#......#", ".#.#.#.#"], id: "select", label: "Select", tool: "select" },
  { glyph: ["...####.", "..#...##", ".#...#.#", "#...#..#", "##.#..#.", "#.#..#..", "##..#...", ".####..."], id: "erase", label: "Eraser", tool: "erase" },
  { glyph: ["...#....", "..###...", ".#.#.#..", "#..#..#.", "#.....#.", ".#...#.#", "..#.#..#", "...#...#"], id: "fill", label: "Fill With Color", tool: "fill" },
  { glyph: [".....###", "....####", "...###..", "..#.#...", ".#.#....", "#.#.....", "##......", "#......."], id: "pick", label: "Pick Color", tool: "pick" },
  { glyph: ["..###...", ".#...#..", "#.....#.", "#.....#.", "#.....#.", ".#...#..", "..###.#.", ".......#"], id: "zoom", label: "Magnifier", tool: "zoom" },
  { glyph: [".....###", "....#..#", "...#..#.", "..#..#..", ".#..#...", "##.#....", "###.....", "##......"], id: "pencil", label: "Pencil" },
  { glyph: [".....##.", "....##..", "...##...", "..##....", ".###....", "####....", "###.....", ".#......"], id: "brush", label: "Brush" },
  { glyph: ["..#.#...", ".#.#.#..", "..#.#.#.", "...####.", "...#..#.", "...#..#.", "...#..#.", "...####."], id: "airbrush", label: "Airbrush" },
  { glyph: ["########", "#..##..#", "...##...", "...##...", "...##...", "...##...", "...##...", "..####.."], id: "text", label: "Text" },
  { glyph: [".......#", "......#.", ".....#..", "....#...", "...#....", "..#.....", ".#......", "#......."], id: "line", label: "Line" },
  { glyph: ["......##", ".....#..", "....#...", "....#...", "...#....", "...#....", "..#.....", "##......"], id: "curve", label: "Curve" },
  { glyph: ["########", "#......#", "#......#", "#......#", "#......#", "#......#", "#......#", "########"], id: "rect", label: "Rectangle" },
  { glyph: ["#####...", "#....##.", "#......#", "#.....#.", ".#...#..", ".#..#...", "..##....", "..#....."], id: "polygon", label: "Polygon" },
  { glyph: ["..####..", ".#....#.", "#......#", "#......#", "#......#", "#......#", ".#....#.", "..####.."], id: "ellipse", label: "Ellipse" },
  { glyph: [".######.", "#......#", "#......#", "#......#", "#......#", "#......#", "#......#", ".######."], id: "roundrect", label: "Rounded Rectangle" },
];

const TOOL_HINTS: Record<Tool, string> = {
  erase: "Erases a task instance, so the scheduler runs the task again.",
  fill: "Fills a task with the current colour, which sets the task instance's state.",
  pick: "Picks a task's state as the current colour.",
  select: "Selects a task. Double-click opens its log in Notepad.",
  zoom: "Changes the magnification. Click to cycle 100%, 200%, 400%.",
};

const ZOOMS = [1, 2, 4];

/* ------------------------------------------------------------------ drawing -- */
function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, colour: string) {
  ctx.fillStyle = colour;
  ctx.fillRect(x, y, w, h);
}

function hline(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number, colour: string, dashed: boolean) {
  const [from, to] = x0 <= x1 ? [x0, x1] : [x1, x0];
  if (!dashed) {
    px(ctx, from, y, to - from + 1, 1, colour);
    return;
  }
  for (let x = from; x <= to; x += 4) px(ctx, x, y, Math.min(2, to - x + 1), 1, colour);
}

function vline(ctx: CanvasRenderingContext2D, x: number, y0: number, y1: number, colour: string, dashed: boolean) {
  const [from, to] = y0 <= y1 ? [y0, y1] : [y1, y0];
  if (!dashed) {
    px(ctx, x, from, 1, to - from + 1, colour);
    return;
  }
  for (let y = from; y <= to; y += 4) px(ctx, x, y, 1, Math.min(2, to - y + 1), colour);
}

function fillDithered(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, hex: string) {
  px(ctx, x, y, w, h, "#ffffff");
  ctx.fillStyle = hex;
  for (let row = 0; row < h; row += 1) {
    for (let column = (row + x + y) % 2; column < w; column += 2) ctx.fillRect(x + column, y + row, 1, 1);
  }
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let end = text.length;
  while (end > 1 && ctx.measureText(`${text.slice(0, end)}…`).width > maxWidth) end -= 1;
  return `${text.slice(0, end)}…`;
}

function isDark(hex: string): boolean {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 150;
}

/** Paint the picture at 1x. Everything is fillRect on integer coordinates: no antialiasing. */
function paintPicture(
  canvas: HTMLCanvasElement,
  picture: Picture,
  summaries: Map<string, Summary>,
  orientation: Orientation,
) {
  canvas.width = picture.width;
  canvas.height = picture.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  px(ctx, 0, 0, picture.width, picture.height, "#ffffff");

  const byId = new Map(picture.nodes.map((node) => [node.id, node]));

  // Edges first, so boxes sit on top of them.
  for (const edge of picture.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const targetState = summaries.get(to.id)?.state;
    const colour = targetState === "upstream_failed" ? "#a80000" : "#000000";
    const dashed = to.triggerRule !== null && to.triggerRule !== "all_success";

    if (orientation === "lr") {
      const y0 = from.y + Math.floor(from.h / 2);
      const y1 = to.y + Math.floor(to.h / 2);
      const x0 = from.x + from.w;
      const x1 = to.x - 1;
      const bend = to.x - Math.floor(GAP_MAIN / 2);
      hline(ctx, x0, bend, y0, colour, dashed);
      vline(ctx, bend, y0, y1, colour, dashed);
      hline(ctx, bend, x1 - 3, y1, colour, dashed);
      // Arrowhead: three pixel columns narrowing into the target.
      px(ctx, x1 - 3, y1 - 2, 1, 5, colour);
      px(ctx, x1 - 2, y1 - 1, 1, 3, colour);
      px(ctx, x1 - 1, y1, 1, 1, colour);
    } else {
      const x0 = from.x + Math.floor(from.w / 2);
      const x1 = to.x + Math.floor(to.w / 2);
      const y0 = from.y + from.h;
      const y1 = to.y - 1;
      const bend = to.y - Math.floor(GAP_MAIN / 2);
      vline(ctx, x0, y0, bend, colour, dashed);
      hline(ctx, x0, x1, bend, colour, dashed);
      vline(ctx, x1, bend, y1 - 3, colour, dashed);
      px(ctx, x1 - 2, y1 - 3, 5, 1, colour);
      px(ctx, x1 - 1, y1 - 2, 3, 1, colour);
      px(ctx, x1, y1 - 1, 1, 1, colour);
    }
  }

  ctx.font = FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const node of picture.nodes) {
    const summary = summaries.get(node.id);
    const colour = COLOUR_BY_KEY.get(colourKey(summary?.state)) as Colour;
    const count = summary?.instances.length ?? 0;

    // A mapped task is a stack of pictures: two offset frames behind the front one.
    if (node.mapped) {
      for (const offset of [4, 2]) {
        px(ctx, node.x + offset, node.y + offset, node.w, node.h, "#000000");
        px(ctx, node.x + offset + 1, node.y + offset + 1, node.w - 2, node.h - 2, "#ffffff");
      }
    }

    px(ctx, node.x, node.y, node.w, node.h, "#000000");
    if (colour.dither) fillDithered(ctx, node.x + 1, node.y + 1, node.w - 2, node.h - 2, colour.hex);
    else px(ctx, node.x + 1, node.y + 1, node.w - 2, node.h - 2, colour.hex);

    const label = fitText(ctx, node.mapped && count > 1 ? `${node.label} ×${count}` : node.label, node.w - 10);
    const cx = node.x + Math.floor(node.w / 2);
    const cy = node.y + Math.floor(node.h / 2) + 1;
    if (colour.dither) {
      // Text on a dither is unreadable; give it the plate Paint's Text tool would.
      const plate = Math.ceil(ctx.measureText(label).width) + 6;
      px(ctx, cx - Math.floor(plate / 2), cy - 7, plate, 13, "#ffffff");
      ctx.fillStyle = "#000000";
    } else {
      ctx.fillStyle = colour.key !== "none" && isDark(colour.hex) ? "#ffffff" : "#000000";
    }
    ctx.fillText(label, cx, cy);
  }
}

/* ---------------------------------------------------------------------- app -- */

interface Document {
  dagId: string;
  /** Pinned run; undefined follows the newest run as they arrive. */
  runId?: string;
}

export function Paint({ props, windowId }: AppProps) {
  const desktop = useDesktop();
  const initialDoc: Document | null =
    typeof props.dagId === "string" && props.dagId
      ? { dagId: props.dagId, runId: typeof props.runId === "string" && props.runId ? props.runId : undefined }
      : null;

  const [doc, setDoc] = useState<Document | null>(initialDoc);
  const [opening, setOpening] = useState(initialDoc === null);
  const [tool, setTool] = useState<Tool>("select");
  const [colour, setColour] = useState("success");
  const [zoom, setZoom] = useState(1);
  const [orientation, setOrientation] = useState<Orientation>("lr");
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; node: Node | null } | null>(null);
  const [showTools, setShowTools] = useState(true);
  const [showColours, setShowColours] = useState(true);
  const [showStatus, setShowStatus] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const dagId = doc?.dagId ?? "";

  const { data: taskData, error: taskError, loading: loadingTasks, refresh: refreshTasks } = usePoll(
    () => (dagId ? airflow.tasks(dagId) : Promise.resolve(null)),
    { deps: [dagId], interval: 0 },
  );
  const {
    data: runData,
    initial: runsInitial,
    refresh: refreshRuns,
  } = usePoll(
    () => (dagId ? airflow.dagRuns(dagId, { limit: 25 }) : Promise.resolve(null)),
    { deps: [dagId], interval: 10000 },
  );

  const runs = runData?.dag_runs ?? [];
  const run: DagRun | undefined = doc?.runId ? runs.find((entry) => entry.dag_run_id === doc.runId) : runs[0];
  const runId = doc?.runId ?? run?.dag_run_id ?? "";

  const { data: tiData, refresh: refreshTis } = usePoll(
    () => (dagId && runId ? airflow.taskInstances(dagId, runId, { limit: 1000 }) : Promise.resolve(null)),
    { deps: [dagId, runId], interval: 3000 },
  );

  const tasks = useMemo(() => taskData?.tasks ?? [], [taskData]);
  const picture = useMemo(() => layout(tasks, orientation), [tasks, orientation]);
  const summaries = useMemo(() => summarise(tiData?.task_instances ?? []), [tiData]);

  useEffect(() => {
    desktop.setTitle(windowId, `${dagId || "untitled"} - Paint`);
  }, [dagId, desktop, windowId]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = globalThis.setTimeout(() => setNotice(null), 4000);
    return () => globalThis.clearTimeout(timer);
  }, [notice]);

  /* ---- canvases: the picture at 1x, and the zoomed view with its animated overlay */

  const offscreen = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ants = useRef(0);

  const running = useMemo(
    () => picture.nodes.filter((node) => ["running", "restarting"].includes(summaries.get(node.id)?.state ?? "")),
    [picture, summaries],
  );

  const composite = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const width = picture.width * zoom;
    const height = picture.height * zoom;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(offscreen.current, 0, 0, width, height);

    if (showGrid && zoom >= 4) {
      ctx.fillStyle = "#c0c0c0";
      for (let x = zoom; x < width; x += zoom) ctx.fillRect(x, 0, 1, height);
      for (let y = zoom; y < height; y += zoom) ctx.fillRect(0, y, width, 1);
    }

    // Marching ants: around whatever is running, and around the selection.
    const antsAround = (node: Node, inset: number) => {
      const x = node.x * zoom - inset + 0.5;
      const y = node.y * zoom - inset + 0.5;
      const w = node.w * zoom + inset * 2 - 1;
      const h = node.h * zoom + inset * 2 - 1;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.strokeStyle = "#ffffff";
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -ants.current;
      ctx.strokeStyle = "#000000";
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    };
    running.forEach((node) => antsAround(node, 0));
    const chosen = selected ? picture.nodes.find((node) => node.id === selected) : undefined;
    if (chosen) antsAround(chosen, 3);
  }, [picture, zoom, showGrid, running, selected]);

  useEffect(() => {
    paintPicture(offscreen.current, picture, summaries, orientation);
    composite();
  }, [picture, summaries, orientation, composite]);

  useEffect(() => {
    if (running.length === 0 && !selected) return undefined;
    let frame = 0;
    let last = 0;
    const loop = (time: number) => {
      if (time - last > 90) {
        last = time;
        ants.current = (ants.current + 1) % 8;
        composite();
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [running, selected, composite]);

  /* ---- actions */

  const refresh = () => {
    refreshTasks();
    refreshRuns();
    refreshTis();
  };

  const nodeAt = (event: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number; node: Node | null } => {
    const x = Math.floor(event.nativeEvent.offsetX / zoom);
    const y = Math.floor(event.nativeEvent.offsetY / zoom);
    const node =
      picture.nodes.find((entry) => x >= entry.x && x < entry.x + entry.w && y >= entry.y && y < entry.y + entry.h) ??
      null;
    return { node, x, y };
  };

  const fail = (text: string, cause: unknown) =>
    desktop.messageBox({
      detail: cause instanceof Error ? cause.message : String(cause),
      icon: "error",
      text,
      title: "Paint",
    });

  const erase = async (node: Node) => {
    const summary = summaries.get(node.id);
    if (!summary || summary.instances.length === 0) {
      await desktop.messageBox({
        icon: "info",
        text: `${node.id} has not run in this dag run, so there is nothing to erase.`,
        title: "Paint",
      });
      return;
    }
    const answer = await desktop.messageBox({
      buttons: [
        { label: "Yes", primary: true, value: "yes" },
        { label: "No", value: "no" },
      ],
      detail: `Clears ${summary.instances.length} task instance(s) in ${runId}, so the scheduler runs the task again. This is Airflow's own Clear, through its REST API.`,
      icon: "question",
      text: `Erase ${node.id}?`,
      title: "Paint",
    });
    if (answer !== "yes") return;
    try {
      await airflow.clearTaskInstances(dagId, runId, [node.id]);
      setNotice(`Erased ${node.id}.`);
      refreshTis();
    } catch (cause) {
      await fail(`${node.id} could not be erased.`, cause);
    }
  };

  const fill = async (node: Node) => {
    const paint = COLOUR_BY_KEY.get(colour) as Colour;
    if (!paint.paintable) {
      await desktop.messageBox({
        detail: "Fill can apply success, failed and skipped, the states Airflow lets a person set. White erases.",
        icon: "info",
        text: `Only the scheduler can paint a task ${paint.label}.`,
        title: "Paint",
      });
      return;
    }
    if (paint.key === "none") {
      await erase(node);
      return;
    }
    const summary = summaries.get(node.id);
    if (!summary || summary.instances.length === 0) {
      await desktop.messageBox({
        icon: "info",
        text: `${node.id} has no task instance in this dag run yet, so there is nothing to paint.`,
        title: "Paint",
      });
      return;
    }
    const answer = await desktop.messageBox({
      buttons: [
        { label: "Yes", primary: true, value: "yes" },
        { label: "No", value: "no" },
      ],
      detail: `Sets the state of ${summary.instances.length} task instance(s) in ${runId} through the Airflow REST API. Downstream tasks are not touched.`,
      icon: "question",
      text: `Paint ${node.id} ${paint.key}?`,
      title: "Paint",
    });
    if (answer !== "yes") return;
    try {
      for (const instance of summary.instances) {
        await airflow.setTaskInstanceState(dagId, runId, node.id, instance.map_index, paint.key);
      }
      setNotice(`Painted ${node.id} ${paint.key}.`);
      refreshTis();
    } catch (cause) {
      await fail(`${node.id} could not be painted.`, cause);
    }
  };

  const openLog = async (node: Node) => {
    const latest = summaries.get(node.id)?.latest;
    if (!latest) {
      await desktop.messageBox({
        icon: "info",
        text: `${node.id} has not run in this dag run, so it has no log yet.`,
        title: "Paint",
      });
      return;
    }
    desktop.openApp(
      "notepad",
      {
        dagId,
        mapIndex: latest.map_index,
        mode: "log",
        runId,
        taskId: node.id,
        tryNumber: Math.max(1, latest.try_number),
      },
      { title: `${node.id} - Notepad` },
    );
  };

  const onCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const { node } = nodeAt(event);
    switch (tool) {
      case "zoom":
        setZoom((value) => ZOOMS[(ZOOMS.indexOf(value) + 1) % ZOOMS.length] ?? 1);
        return;
      case "select":
        setSelected(node?.id ?? null);
        return;
      case "pick":
        if (node) {
          setColour(colourKey(summaries.get(node.id)?.state));
          setSelected(node.id);
          setNotice(`Picked ${summaries.get(node.id)?.state ?? "no status"} from ${node.id}.`);
        }
        return;
      case "fill":
        if (node) void fill(node);
        return;
      case "erase":
        if (node) void erase(node);
        return;
      default:
    }
  };

  const saveAs = () => {
    const ctx = offscreen.current.getContext("2d");
    if (!ctx || picture.width === 0) return;
    const blob = encodeBmp(ctx.getImageData(0, 0, picture.width, picture.height));
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${dagId || "untitled"}.bmp`;
    link.click();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(`Saved ${link.download} (${(blob.size / 1024).toFixed(0)} KB, 24-bit bitmap).`);
  };

  const attributes = () => {
    const states = new Set([...summaries.values()].map((summary) => summary.state ?? "none"));
    void desktop.messageBox({
      detail: `${picture.nodes.length} task(s) in ${picture.layers} layer(s), ${picture.edges.length} dependenc${
        picture.edges.length === 1 ? "y" : "ies"
      }. ${states.size} colour(s) on the canvas. Run: ${runId || "none"}.`,
      icon: "info",
      text: `Width: ${picture.width} pixels    Height: ${picture.height} pixels    Colors: 24-bit`,
      title: "Attributes",
    });
  };

  const legend = () =>
    void desktop.messageBox({
      detail: COLOURS.map((entry) => `${entry.label}${entry.dither ? " (dithered)" : ""}${entry.paintable ? " *" : ""}`).join("  ·  "),
      icon: "info",
      text: "Each colour in the box is a task instance state. White is a task that has not run. Colours marked * can be applied with Fill.",
      title: "Colors",
    });

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "F5") {
      event.preventDefault();
      refresh();
    } else if (event.key === "Escape") {
      setSelected(null);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
      event.preventDefault();
      setOpening(true);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveAs();
    }
  };

  /* ---- menus */

  const menus: Menu[] = [
    {
      items: [
        { accel: "Ctrl+O", label: "Open…", onSelect: () => setOpening(true) },
        { accel: "Ctrl+S", disabled: !dagId, label: "Save As…", onSelect: saveAs },
        "separator",
        { label: "Exit", onSelect: () => desktop.close(windowId) },
      ],
      label: "File",
    },
    {
      items: [
        { disabled: true, label: "Undo" },
        "separator",
        {
          disabled: !selected,
          label: "Copy task id",
          onSelect: () => {
            if (selected) void navigator.clipboard?.writeText(selected).then(() => setNotice(`Copied ${selected}.`));
          },
        },
        { accel: "Esc", disabled: !selected, label: "Clear Selection", onSelect: () => setSelected(null) },
      ],
      label: "Edit",
    },
    {
      items: [
        { checked: showTools, label: "Tool Box", onSelect: () => setShowTools((value) => !value) },
        { checked: showColours, label: "Color Box", onSelect: () => setShowColours((value) => !value) },
        { checked: showStatus, label: "Status Bar", onSelect: () => setShowStatus((value) => !value) },
        "separator",
        ...ZOOMS.map((value) => ({
          checked: zoom === value,
          label: `Zoom ${value * 100}%`,
          onSelect: () => setZoom(value),
        })),
        { checked: showGrid, disabled: zoom < 4, label: "Show Grid", onSelect: () => setShowGrid((value) => !value) },
        "separator",
        { accel: "F5", label: "Refresh", onSelect: refresh },
      ],
      label: "View",
    },
    {
      items: [
        {
          label: orientation === "lr" ? "Flip/Rotate: top to bottom" : "Flip/Rotate: left to right",
          onSelect: () => setOrientation((value) => (value === "lr" ? "tb" : "lr")),
        },
        "separator",
        { disabled: !dagId, label: "Attributes…", onSelect: attributes },
      ],
      label: "Image",
    },
    { items: [{ label: "Legend…", onSelect: legend }], label: "Colors" },
    {
      items: [
        { label: "Help Topics", onSelect: () => desktop.openApp("winhelp", {}, { singleton: true }) },
        "separator",
        {
          label: "About Paint",
          onSelect: () =>
            void desktop.messageBox({
              detail:
                "Boxes are tasks, lines are dependencies, colours are task instance states, and the picture repaints itself from the metadata database every few seconds. Fill and the Eraser write through the Airflow REST API.",
              icon: "info",
              text: "Paint: a dag as a bitmap.",
              title: "About Paint",
            }),
        },
      ],
      label: "Help",
    },
  ];

  /* ---- status */

  const hoverSummary = hover?.node ? summaries.get(hover.node.id) : undefined;
  const hint = notice
    ? notice
    : hover?.node
      ? `${hover.node.id}: ${hoverSummary?.state ?? "no status"}${
          hoverSummary && hoverSummary.instances.length > 1 ? ` ×${hoverSummary.instances.length}` : ""
        }${hoverSummary?.latest ? ` · try ${hoverSummary.latest.try_number} · ${formatDuration(hoverSummary.latest.duration)}` : ""}${
          hoverSummary?.latest?.operator ? ` · ${hoverSummary.latest.operator}` : ""
        }`
      : TOOL_HINTS[tool];

  const currentColour = COLOUR_BY_KEY.get(colour) as Colour;
  const cursor = tool === "zoom" ? "zoom-in" : tool === "select" ? "default" : "crosshair";

  let workspace: ReactNode;
  if (opening) {
    workspace = (
      <OpenPanel
        current={doc}
        onCancel={() => (doc ? setOpening(false) : desktop.close(windowId))}
        onOpen={(next) => {
          setDoc(next);
          setSelected(null);
          setOpening(false);
        }}
      />
    );
  } else if (taskError) {
    workspace = (
      <div style={{ background: "var(--face)", margin: 4 }}>
        <ErrorNotice error={taskError} />
      </div>
    );
  } else if ((loadingTasks && tasks.length === 0) || runsInitial) {
    // Until the runs are known every box would be white, which reads as "never ran".
    workspace = <div style={{ color: "#ffffff", padding: 8 }}>Loading picture…</div>;
  } else if (tasks.length === 0) {
    workspace = <div style={{ color: "#ffffff", padding: 8 }}>This dag has no tasks, so the canvas is empty.</div>;
  } else {
    workspace = (
      <canvas
        onClick={onCanvasClick}
        onDoubleClick={(event) => {
          const { node } = nodeAt(event);
          if (node && tool === "select") void openLog(node);
        }}
        onPointerLeave={() => setHover(null)}
        onPointerMove={(event) => setHover(nodeAt(event))}
        ref={canvasRef}
        style={{ cursor, display: "block", imageRendering: "pixelated", margin: 3 }}
      />
    );
  }

  return (
    <div className="aos-col aos-grow" onKeyDown={onKeyDown} style={{ gap: 0, outline: "none" }} tabIndex={0}>
      <MenuBar menus={menus} />

      <div className="aos-row aos-grow" style={{ alignItems: "stretch", gap: 0 }}>
        {showTools ? (
          <ToolBox
            active={tool}
            onHover={(label) => setNotice(label)}
            onPick={(next) => {
              setTool(next);
              setNotice(null);
            }}
          />
        ) : null}
        <div className="aos-sunken aos-grow aos-scroll" style={{ background: "#808080", padding: 2 }}>
          {workspace}
        </div>
      </div>

      {showColours ? (
        <ColourBox
          current={currentColour}
          onHover={(label) => setNotice(label)}
          onPick={(key) => {
            setColour(key);
            setNotice(null);
          }}
        />
      ) : null}

      {showStatus ? (
        <StatusBar
          panes={[
            hint,
            run ? (
              <span className="aos-row" style={{ gap: 4 }} title={run.dag_run_id}>
                <StateDot state={run.state} />
                <span style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>{run.dag_run_id}</span>
                {doc?.runId ? "" : "(latest)"}
              </span>
            ) : (
              ""
            ),
            hover ? `${hover.x},${hover.y}` : "",
            `${picture.width}x${picture.height}`,
          ]}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- tool box -- */

function Glyph({ grid }: { readonly grid: string[] }) {
  return (
    <svg aria-hidden="true" height={16} shapeRendering="crispEdges" viewBox="0 0 8 8" width={16}>
      {grid.flatMap((row, y) =>
        [...row].map((cell, x) => (cell === "#" ? <rect fill="currentColor" height={1} key={`${x}-${y}`} width={1} x={x} y={y} /> : null)),
      )}
    </svg>
  );
}

function ToolBox({
  active,
  onHover,
  onPick,
}: {
  readonly active: Tool;
  readonly onPick: (tool: Tool) => void;
  readonly onHover: (label: string | null) => void;
}) {
  return (
    <div style={{ display: "grid", flex: "none", gap: 1, gridTemplateColumns: "26px 26px", padding: "3px 3px 3px 2px" }}>
      {TOOLS.map((definition) => {
        const enabled = definition.tool !== undefined;
        return (
          <button
            className="aos-btn"
            data-pressed={definition.tool === active ? "true" : undefined}
            disabled={!enabled}
            key={definition.id}
            onClick={() => (definition.tool ? onPick(definition.tool) : undefined)}
            onPointerEnter={() =>
              onHover(enabled ? null : `${definition.label}: not available. Airflow has no metadata column for that.`)
            }
            onPointerLeave={() => onHover(null)}
            style={{ height: 26, minWidth: 0, padding: 0, width: 26 }}
            title={definition.label}
            type="button"
          >
            <span style={{ color: enabled ? "var(--text)" : "var(--text-disabled)", display: "block", margin: "0 auto", width: 16 }}>
              <Glyph grid={definition.glyph} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ colour box -- */

function swatchStyle(colour: Colour): React.CSSProperties {
  return colour.dither
    ? {
        background: `repeating-conic-gradient(${colour.hex} 0 25%, #ffffff 0 50%) 0 0 / 2px 2px`,
      }
    : { background: colour.hex };
}

function ColourBox({
  current,
  onHover,
  onPick,
}: {
  readonly current: Colour;
  readonly onPick: (key: string) => void;
  readonly onHover: (label: string | null) => void;
}) {
  return (
    <div className="aos-row" style={{ flex: "none", gap: 6, padding: "4px 4px 2px" }}>
      {/* Paint's foreground/background swatch: what Fill paints, over white (unpainted). */}
      <div className="aos-sunken" style={{ flex: "none", height: 34, position: "relative", width: 34 }}>
        <div className="aos-sunken" style={{ background: "#ffffff", height: 16, left: 12, position: "absolute", top: 12, width: 16 }} />
        <div className="aos-sunken" style={{ height: 16, left: 6, position: "absolute", top: 6, width: 16, ...swatchStyle(current) }} title={current.label} />
      </div>
      <div className="aos-sunken" style={{ display: "grid", gap: 0, gridAutoFlow: "column", gridTemplateRows: "16px 16px", padding: 1 }}>
        {COLOURS.map((colour) => (
          <button
            key={colour.key}
            onClick={() => onPick(colour.key)}
            onPointerEnter={() => onHover(`${colour.label}${colour.paintable ? "" : " — the scheduler's colour; Fill cannot apply it"}`)}
            onPointerLeave={() => onHover(null)}
            style={{
              border: "none",
              boxShadow: current.key === colour.key ? "inset 0 0 0 1px #ffffff, inset 0 0 0 2px #000000" : "var(--border-thin-sunken)",
              cursor: "default",
              height: 16,
              padding: 0,
              width: 16,
              ...swatchStyle(colour),
            }}
            title={colour.label}
            type="button"
          />
        ))}
      </div>
      <div style={{ color: "var(--text-disabled)" }}>{current.label}</div>
    </div>
  );
}

/* ------------------------------------------------------------- open panel -- */

/** File → Open: a dag is a file, its runs are the versions of it. */
function OpenPanel({
  current,
  onCancel,
  onOpen,
}: {
  readonly current: Document | null;
  readonly onOpen: (doc: Document) => void;
  readonly onCancel: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [dagId, setDagId] = useState(current?.dagId ?? "");
  const [runId, setRunId] = useState<string | undefined>(current?.runId);

  const { data: dagData, error, initial } = usePoll(() => airflow.dags({ limit: 200 }), { interval: 0 });
  const { data: runData } = usePoll(
    () => (dagId ? airflow.dagRuns(dagId, { limit: 25 }) : Promise.resolve(null)),
    { deps: [dagId], interval: 0 },
  );

  const dags = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const rows = dagData?.dags ?? [];
    return needle ? rows.filter((dag) => dag.dag_id.toLowerCase().includes(needle)) : rows;
  }, [dagData, filter]);

  const runs = runData?.dag_runs ?? [];
  const fileName = dagId ? `C:\\${dagId}\\${runId ?? "(latest run)"}.bmp` : "";

  if (error) return <ErrorNotice error={error} />;

  return (
    <div className="aos-col" style={{ background: "var(--face)", gap: 8, margin: 4, padding: 10 }}>
      <div className="aos-row" style={{ gap: 8 }}>
        <span>Look in:</span>
        <Field onChange={setFilter} placeholder="Filter dags" style={{ flex: 1 }} value={filter} />
      </div>
      <div className="aos-row" style={{ alignItems: "stretch", gap: 8, height: 220 }}>
        <div className="aos-well aos-grow aos-scroll" style={{ padding: 2 }}>
          {dags.map((dag) => (
            <button
              className="aos-menu-item"
              data-selected={dag.dag_id === dagId ? "true" : undefined}
              key={dag.dag_id}
              onClick={() => {
                setDagId(dag.dag_id);
                setRunId(undefined);
              }}
              onDoubleClick={() => onOpen({ dagId: dag.dag_id })}
              style={dag.dag_id === dagId ? { background: "var(--selection)", color: "var(--selection-text)" } : undefined}
              type="button"
            >
              <StateDot state={dag.has_import_errors ? "failed" : dag.is_paused ? "paused" : "success"} />
              <span>{dag.dag_id}</span>
            </button>
          ))}
          {dags.length === 0 ? (
            <div style={{ color: "var(--text-disabled)", padding: 6 }}>
              {initial ? "Reading dags…" : "No dag matches that name."}
            </div>
          ) : null}
        </div>
        <div className="aos-well aos-scroll" style={{ padding: 2, width: 300 }}>
          {dagId ? (
            <button
              className="aos-menu-item"
              onClick={() => setRunId(undefined)}
              style={runId === undefined ? { background: "var(--selection)", color: "var(--selection-text)" } : undefined}
              type="button"
            >
              <span style={{ width: 8 }} />
              <span>Latest run (follows new runs)</span>
            </button>
          ) : (
            <div style={{ color: "var(--text-disabled)", padding: 6 }}>Pick a dag to list its runs.</div>
          )}
          {runs.map((run) => (
            <button
              className="aos-menu-item"
              key={run.dag_run_id}
              onClick={() => setRunId(run.dag_run_id)}
              onDoubleClick={() => onOpen({ dagId, runId: run.dag_run_id })}
              style={runId === run.dag_run_id ? { background: "var(--selection)", color: "var(--selection-text)" } : undefined}
              type="button"
            >
              <StateDot state={run.state} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{run.dag_run_id}</span>
              <span className="aos-menu-accel" style={{ opacity: 0.7 }}>
                {formatWhen(run.run_after)}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="aos-row" style={{ gap: 8 }}>
        <span>File name:</span>
        <div className="aos-well aos-grow aos-mono" style={{ minHeight: 20, padding: "3px 5px" }}>
          {fileName}
        </div>
        <Button disabled={!dagId} onClick={() => onOpen({ dagId, runId })}>
          Open
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
      <div style={{ color: "var(--text-disabled)" }}>Files of type: Dag (*.bmp). Every picture is drawn live from the metadata database.</div>
    </div>
  );
}
