/** Mirrors of airflow_os.schemas, plus the slices of the Airflow REST API we consume. */

export interface ProcessRow {
  /** TaskInstance.id — the identity. `pid` is decoration and can collide. */
  ti_id: string;
  pid: number;
  synthetic_pid: boolean;
  image_name: string;
  dag_id: string;
  run_id: string;
  task_id: string;
  map_index: number;
  display_name: string;
  owner: string;
  state: string;
  cpu: number;
  elapsed: number;
  mem_k: number;
  try_number: number;
  max_tries: number;
  priority: string;
  priority_weight: number;
  pool: string;
  pool_slots: number;
  operator: string | null;
  hostname: string | null;
  queue: string | null;
  executor: string | null;
  start_date: string | null;
  end_date: string | null;
  is_deferred: boolean;
}

export interface PerformanceInfo {
  cpu_usage: number;
  cpu_running: number;
  cpu_total: number;
  mem_usage: number;
  mem_used_slots: number;
  mem_total_slots: number;
  queued: number;
  deferred: number;
  running_dag_runs: number;
  handles: number;
  threads: number;
  processes: number;
}

export interface SystemInfo {
  airflow_version: string;
  airflow_os_version: string;
  bundle_built: string | null;
  python_version: string;
  executor: string;
  auth_manager: string;
  timezone: string;
  dag_bundles: string[];
  scheduler_alive: boolean;
  scheduler_heartbeat: string | null;
  scheduler_hostname: string | null;
  uptime_seconds: number | null;
  dags_total: number;
  dags_paused: number;
  dags_broken: number;
  parallelism: number;
  max_active_tasks_per_dag: number;
  performance: PerformanceInfo;
}

export interface FsEntry {
  name: string;
  path: string;
  kind: "drive" | "folder" | "file";
  icon: string;
  size: number | null;
  modified: string | null;
  state: string | null;
  detail: string | null;
  task_id: string | null;
  map_index: number | null;
  try_number: number | null;
}

export interface FsListing {
  path: string;
  title: string;
  parent: string | null;
  entries: FsEntry[];
}

export interface FsFile {
  path: string;
  name: string;
  content: string;
  language: string;
  truncated: boolean;
}

export interface KillResult {
  pid: number;
  task_id: string;
  dag_id: string;
  run_id: string;
  previous_state: string | null;
  new_state: string;
}

export interface ControlPanelData {
  variables: { key: string; description: string | null; is_encrypted: boolean }[];
  connections: {
    conn_id: string;
    conn_type: string | null;
    host: string | null;
    schema: string | null;
    login: string | null;
    port: number | null;
    description: string | null;
  }[];
  pools: {
    name: string;
    slots: number;
    description: string | null;
    include_deferred: boolean;
    occupied_slots: number;
  }[];
}

/* ----------------------------------------------- Airflow public REST API -- */

export interface Dag {
  dag_id: string;
  dag_display_name: string;
  is_paused: boolean;
  is_stale: boolean;
  description: string | null;
  owners: string[];
  tags: { name: string }[];
  timetable_summary: string | null;
  next_dagrun_logical_date: string | null;
  has_import_errors: boolean;
  file_token?: string;
  fileloc?: string;
}

export interface DagRun {
  dag_run_id: string;
  dag_id: string;
  state: string;
  run_type: string;
  logical_date: string | null;
  start_date: string | null;
  end_date: string | null;
  run_after: string | null;
  note: string | null;
}

/** One task of a dag's structure, from /dags/{id}/tasks. Enough to draw the graph. */
export interface DagTask {
  task_id: string;
  task_display_name: string | null;
  operator_name: string | null;
  downstream_task_ids: string[];
  is_mapped: boolean;
  trigger_rule: string | null;
  doc_md: string | null;
  ui_color: string | null;
}

export interface TaskInstance {
  task_id: string;
  dag_id: string;
  dag_run_id: string;
  map_index: number;
  state: string | null;
  try_number: number;
  duration: number | null;
  start_date: string | null;
  end_date: string | null;
  operator: string | null;
  note: string | null;
}

export interface EventLogEntry {
  event_log_id: number;
  when: string;
  dag_id: string | null;
  task_id: string | null;
  run_id: string | null;
  event: string;
  owner: string | null;
  extra: string | null;
}

export interface RecycledItem {
  key: string;
  kind: "dag" | "task";
  name: string;
  dag_id: string;
  run_id: string | null;
  task_id: string | null;
  map_index: number | null;
  deleted_at: string | null;
  detail: string | null;
  restorable: boolean;
}

export interface DeadlineItem {
  id: string;
  dag_id: string | null;
  run_id: string | null;
  name: string | null;
  description: string | null;
  deadline_time: string;
  missed: boolean;
  created_at: string | null;
  reference: string | null;
  interval: string | null;
  callback: string | null;
  dag_run_state: string | null;
}

export interface HitlRequest {
  ti_id: string;
  dag_id: string;
  run_id: string;
  task_id: string;
  map_index: number;
  task_state: string | null;
  subject: string;
  body: string | null;
  options: string[];
  defaults: string[] | null;
  multiple: boolean;
  params: Record<string, unknown>;
  assignees: { id: string; name: string }[];
  created_at: string | null;
  responded_at: string | null;
  responded_by: string | null;
  chosen_options: string[] | null;
}

