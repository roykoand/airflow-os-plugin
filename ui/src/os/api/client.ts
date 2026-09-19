/**
 * Two backends sit behind the desktop:
 *
 *  - the plugin's own kernel API, for the aggregate Win95 views (process table,
 *    performance counters, synthetic filesystem);
 *  - Airflow's public REST API, for everything it already models well - triggering
 *    dags, clearing tasks, reading logs, audit events.
 *
 * Both are same-origin and authenticate with the api-server's `_token` cookie, so
 * requests just need `credentials: "same-origin"`.
 */

import type {
  ControlPanelData,
  Dag,
  DagRun,
  DagTask,
  EventLogEntry,
  FsEntry,
  FsFile,
  DeadlineItem,
  FsListing,
  HitlRequest,
  KillResult,
  PerformanceInfo,
  ProcessRow,
  RecycledItem,
  SystemInfo,
  TaskInstance,
} from "./types";

/** The api-server's mount path. Resolved the same way the host Airflow UI does it. */
export function basePath(): string {
  const href = document.querySelector("head > base")?.getAttribute("href") ?? "";
  return href.endsWith("/") ? href.slice(0, -1) : href;
}

const KERNEL_PREFIX = "/airflow-os";
const API_PREFIX = "/api/v2";

/** Mirrors the kernel's `PROCESS_LIMIT`: a full page means the list was cut short. */
export const PROCESS_LIMIT = 500;

export class ApiError extends Error {
  public readonly status: number;

  public readonly detail: unknown;

  public constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }

  /**
   * The api-server's `_token` cookie has expired. Nothing the desktop can retry will
   * help - the token is minted by the login flow, which lives outside the plugin - so
   * callers offer a way back to it rather than another refresh. 403 is deliberately
   * not included: that is an authorised session being told no by the access checks,
   * and logging on again would not change the answer.
   */
  public get expired(): boolean {
    return this.status === 401;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    ...init,
  });

  if (!response.ok) {
    let detail: unknown;
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      detail = body.detail;
      if (typeof body.detail === "string") message = body.detail;
    } catch {
      // A non-JSON error body (an HTML proxy page, say) leaves the status text.
    }
    throw new ApiError(response.status, message, detail);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function query(params: Record<string, string | number | boolean | undefined | string[]>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((entry) => search.append(key, entry));
    else search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

/* ------------------------------------------------------------ kernel API -- */

export const kernel = {
  controlPanel: () => request<ControlPanelData>(`${basePath()}${KERNEL_PREFIX}/control-panel`),

  /** Deadlines. No public REST API exists for these, hence the kernel endpoint. */
  deadlines: (missedOnly = false) =>
    request<DeadlineItem[]>(
      `${basePath()}${KERNEL_PREFIX}/deadlines${query({ missed_only: missedOnly })}`,
    ),

  drives: () => request<FsEntry[]>(`${basePath()}${KERNEL_PREFIX}/fs/drives`),

  /**
   * End a process. Addressed by TaskInstance.id, never by the PID on screen: synthetic
   * PIDs are a CRC32 into 64512 slots and collide well before the list is full, so
   * resolving from a PID could fail someone else's task.
   */
  endProcess: (tiId: string) =>
    request<KillResult>(
      `${basePath()}${KERNEL_PREFIX}/processes/${encodeURIComponent(tiId)}/end`,
      { method: "POST" },
    ),

  /**
   * Evidence for one failed task instance. Collected server-side because Airflow 3
   * task code cannot read the metadata DB, so the desktop hands this to Clippy's
   * triage dag in its run conf.
   */
  evidence: (target: {
    dag_id: string;
    run_id: string;
    task_id: string;
    map_index: number;
    try_number: number;
  }) => request<Record<string, unknown>>(`${basePath()}${KERNEL_PREFIX}/evidence${query(target)}`),

  hitl: (includeAnswered = false) =>
    request<HitlRequest[]>(
      `${basePath()}${KERNEL_PREFIX}/hitl${query({ include_answered: includeAnswered })}`,
    ),

  list: (path: string) =>
    request<FsListing>(`${basePath()}${KERNEL_PREFIX}/fs/list${query({ path })}`),

  performance: () => request<PerformanceInfo>(`${basePath()}${KERNEL_PREFIX}/performance`),

  processes: (includeFinished = false) =>
    request<ProcessRow[]>(
      `${basePath()}${KERNEL_PREFIX}/processes${query({ include_finished: includeFinished })}`,
    ),

  /** Permanently drop a stale dag's record. Refused if its file is still present. */
  purgeDag: (dagId: string) =>
    request<{ dag_id: string; status: string }>(
      `${basePath()}${KERNEL_PREFIX}/recycle-bin/dags/${encodeURIComponent(dagId)}`,
      { method: "DELETE" },
    ),

  read: (path: string) => request<FsFile>(`${basePath()}${KERNEL_PREFIX}/fs/read${query({ path })}`),

  /**
   * Everything waiting on a human, deployment-wide. The core API only lists HITL
   * details one dag run at a time, which cannot answer "what needs me?".
   */
  /** Stale dags and removed task instances - deleted by Airflow, not thrown away. */
  recycleBin: () => request<RecycledItem[]>(`${basePath()}${KERNEL_PREFIX}/recycle-bin`),

  system: () => request<SystemInfo>(`${basePath()}${KERNEL_PREFIX}/system`),
};

/* -------------------------------------------------------- Airflow REST API -- */

interface DagCollection {
  dags: Dag[];
  total_entries: number;
}

interface DagRunCollection {
  dag_runs: DagRun[];
  total_entries: number;
}

interface TaskInstanceCollection {
  task_instances: TaskInstance[];
  total_entries: number;
}

interface EventLogCollection {
  event_logs: EventLogEntry[];
  total_entries: number;
}

interface LogResponse {
  content: unknown;
  continuation_token: string | null;
}

export const airflow = {
  /** Clear a whole dag run so the scheduler re-runs it. */
  clearDagRun: (dagId: string, runId: string, onlyFailed = false) =>
    request<unknown>(
      `${basePath()}${API_PREFIX}/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(
        runId,
      )}/clear`,
      { body: JSON.stringify({ dry_run: false, only_failed: onlyFailed }), method: "POST" },
    ),

  /**
   * Clear task instances so the scheduler runs them again. Airflow's own clear
   * endpoint, so the reset of downstream state and of the dag run is its logic.
   */
  clearTaskInstances: (dagId: string, runId: string, taskIds: string[]) =>
    request<unknown>(`${basePath()}${API_PREFIX}/dags/${encodeURIComponent(dagId)}/clearTaskInstances`, {
      body: JSON.stringify({
        dag_run_id: runId,
        dry_run: false,
        include_downstream: false,
        include_upstream: false,
        only_failed: false,
        reset_dag_runs: true,
        task_ids: taskIds,
      }),
      method: "POST",
    }),

  /** Dag details, which is where doc_md lives. */
  dagDetails: (dagId: string) =>
    request<Dag & { doc_md: string | null; last_parsed_time: string | null }>(
      `${basePath()}${API_PREFIX}/dags/${encodeURIComponent(dagId)}/details`,
    ),

  dagRuns: (dagId: string, params: { limit?: number; order_by?: string } = {}) =>
    request<DagRunCollection>(
      `${basePath()}${API_PREFIX}/dags/${encodeURIComponent(dagId)}/dagRuns${query({
        limit: 50,
        order_by: "-run_after",
        ...params,
      })}`,
    ),

  dags: (params: { limit?: number; offset?: number; dag_id_pattern?: string; paused?: boolean } = {}) =>
    request<DagCollection>(`${basePath()}${API_PREFIX}/dags${query({ limit: 100, ...params })}`),

  eventLogs: (params: { limit?: number; offset?: number; order_by?: string; dag_id?: string } = {}) =>
    request<EventLogCollection>(
      `${basePath()}${API_PREFIX}/eventLogs${query({ limit: 200, order_by: "-when", ...params })}`,
    ),

  health: () => request<Record<string, { status: string | null }>>(`${basePath()}${API_PREFIX}/monitor/health`),

  /**
   * Answer a human-in-the-loop request. Goes through the public REST API so the task
   * resume path, validation and audit entry are Airflow's rather than ours.
   */
  respondHitl: (
    dagId: string,
    runId: string,
    taskId: string,
    mapIndex: number,
    body: { chosen_options: string[]; params_input?: Record<string, unknown> },
  ) =>
    request<unknown>(
      `${basePath()}${API_PREFIX}/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(
        runId,
      )}/taskInstances/${encodeURIComponent(taskId)}/${mapIndex}/hitlDetails`,
      { body: JSON.stringify({ params_input: {}, ...body }), method: "PATCH" },
    ),

  setPaused: (dagId: string, isPaused: boolean) =>
    request<Dag>(`${basePath()}${API_PREFIX}/dags/${encodeURIComponent(dagId)}`, {
      body: JSON.stringify({ is_paused: isPaused }),
      method: "PATCH",
    }),

  /** Set one task instance's state. `new_state: null` clears it back to scheduled. */
  setTaskInstanceState: (
    dagId: string,
    runId: string,
    taskId: string,
    mapIndex: number,
    newState: string | null,
  ) =>
    request<TaskInstance>(
      `${basePath()}${API_PREFIX}/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(
        runId,
      )}/taskInstances/${encodeURIComponent(taskId)}/${mapIndex}${query({
        update_mask: "new_state",
      })}`,
      { body: JSON.stringify({ new_state: newState }), method: "PATCH" },
    ),

  /** One task instance, for polling a triage run to completion. */
  taskInstance: (dagId: string, runId: string, taskId: string) =>
    request<TaskInstance>(
      `${basePath()}${API_PREFIX}/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(
        runId,
      )}/taskInstances/${encodeURIComponent(taskId)}`,
    ),

  taskInstances: (dagId: string, runId: string, params: { limit?: number } = {}) =>
    request<TaskInstanceCollection>(
      `${basePath()}${API_PREFIX}/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(
        runId,
      )}/taskInstances${query({ limit: 200, ...params })}`,
    ),

  /**
   * Task logs. The endpoint returns either a plain string or a list of structured
   * log chunks depending on the configured handler, so both shapes are flattened here.
   */
  taskLog: async (
    dagId: string,
    runId: string,
    taskId: string,
    tryNumber: number,
    mapIndex = -1,
  ): Promise<string> => {
    const url = `${basePath()}${API_PREFIX}/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(
      runId,
    )}/taskInstances/${encodeURIComponent(taskId)}/logs/${tryNumber}${query({
      map_index: mapIndex,
    })}`;
    const response = await request<LogResponse>(url);
    return flattenLog(response.content);
  },

  /** The tasks of a dag: doc_md for Help, downstream_task_ids for Paint's graph. */
  tasks: (dagId: string) =>
    request<{ tasks: DagTask[] }>(`${basePath()}${API_PREFIX}/dags/${encodeURIComponent(dagId)}/tasks`),

  triggerDag: (dagId: string, body: Record<string, unknown> = {}) =>
    request<DagRun>(`${basePath()}${API_PREFIX}/dags/${encodeURIComponent(dagId)}/dagRuns`, {
      body: JSON.stringify({ logical_date: null, ...body }),
      method: "POST",
    }),

  version: () => request<{ version: string; git_version: string | null }>(`${basePath()}${API_PREFIX}/version`),

  /** One XCom value. Used to collect Clippy's verdict from its triage run. */
  xcom: <T = unknown>(dagId: string, runId: string, taskId: string, key = "return_value") =>
    request<{ key: string; value: T }>(
      `${basePath()}${API_PREFIX}/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(
        runId,
      )}/taskInstances/${encodeURIComponent(taskId)}/xcomEntries/${encodeURIComponent(key)}`,
    ),
};

function flattenLog(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object") {
        const record = chunk as Record<string, unknown>;
        if (typeof record.event === "string") {
          const timestamp = typeof record.timestamp === "string" ? `${record.timestamp} ` : "";
          const level = typeof record.level === "string" ? `[${record.level.toUpperCase()}] ` : "";
          return `${timestamp}${level}${record.event}`;
        }
        return JSON.stringify(chunk);
      }
      return String(chunk);
    })
    .join("\n");
}
