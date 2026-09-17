import { useState } from "react";

import { kernel } from "../api/client";
import {
  Button,
  Column,
  ErrorNotice,
  ListView,
  Progress,
  StatusBar,
  Tabs,
  useSort,
} from "../components/widgets";
import { usePoll } from "../hooks/usePoll";
import { crashFor } from "../components/Bsod";
import { useDesktop } from "../kernel/desktop";
import { readFlag, writeFlag } from "../kernel/prefs";
import { sound, SOUND_EVENTS, type SoundName } from "../kernel/sound";
import type { ControlPanelData } from "../api/types";

type Variable = ControlPanelData["variables"][number];
type Connection = ControlPanelData["connections"][number];
type PoolRow = ControlPanelData["pools"][number];

/**
 * Control Panel. Variables are the registry, Connections are Dial-Up Networking,
 * Pools are the memory manager. Read-only by design: editing secrets belongs in the
 * real Airflow UI, where the audit trail and permission checks live.
 */
export function ControlPanel() {
  const [tab, setTab] = useState("pools");
  const { data, error, initial } = usePoll(kernel.controlPanel, { interval: 15_000 });

  if (error) return <ErrorNotice error={error} />;

  return (
    <Tabs
      active={tab}
      onChange={setTab}
      tabs={[
        { id: "pools", label: "System (Pools)" },
        { id: "variables", label: "Registry (Variables)" },
        { id: "connections", label: "Dial-Up Networking" },
        { id: "sounds", label: "Sounds" },
        { id: "display", label: "Display" },
      ]}
    >
      {tab === "pools" ? <Pools initial={initial} rows={data?.pools ?? []} /> : null}
      {tab === "variables" ? <Variables initial={initial} rows={data?.variables ?? []} /> : null}
      {tab === "connections" ? <Connections initial={initial} rows={data?.connections ?? []} /> : null}
      {tab === "sounds" ? <Sounds /> : null}
      {tab === "display" ? <Display /> : null}
    </Tabs>
  );
}

function Pools({ initial, rows }: { readonly rows: PoolRow[]; readonly initial: boolean }) {
  const columns: Column<PoolRow>[] = [
    { key: "name", label: "Pool", render: (row) => row.name, sort: (row) => row.name },
    {
      key: "usage",
      label: "Slots in use",
      render: (row) => (
        <div style={{ minWidth: 120 }}>
          <Progress value={row.slots ? (row.occupied_slots / row.slots) * 100 : 0} />
        </div>
      ),
      sort: (row) => (row.slots ? row.occupied_slots / row.slots : 0),
    },
    {
      key: "slots",
      label: "Used / Total",
      numeric: true,
      render: (row) => `${row.occupied_slots} / ${row.slots}`,
      sort: (row) => row.occupied_slots,
    },
    {
      key: "deferred",
      label: "Counts deferred",
      render: (row) => (row.include_deferred ? "Yes" : "No"),
      sort: (row) => String(row.include_deferred),
    },
    { key: "description", label: "Description", render: (row) => row.description ?? "", sort: (row) => row.description ?? "" },
  ];
  const sorter = useSort(columns, "name");
  const totalSlots = rows.reduce((sum, row) => sum + row.slots, 0);
  const usedSlots = rows.reduce((sum, row) => sum + row.occupied_slots, 0);

  return (
    <>
      <ListView
        columns={columns}
        empty={initial ? "Reading…" : "No pools are configured."}
        rowKey={(row) => row.name}
        rows={sorter.apply(rows)}
        {...sorter}
      />
      <StatusBar panes={[`${rows.length} pool(s)`, `${usedSlots} of ${totalSlots} slots occupied`]} />
    </>
  );
}

function Variables({ initial, rows }: { readonly rows: Variable[]; readonly initial: boolean }) {
  const columns: Column<Variable>[] = [
    { key: "key", label: "Key", render: (row) => row.key, sort: (row) => row.key },
    {
      key: "encrypted",
      label: "Encrypted",
      render: (row) => (row.is_encrypted ? "Yes" : "No"),
      sort: (row) => String(row.is_encrypted),
    },
    {
      key: "description",
      label: "Description",
      render: (row) => row.description ?? "",
      sort: (row) => row.description ?? "",
    },
  ];
  const sorter = useSort(columns, "key");

  return (
    <>
      <ListView
        columns={columns}
        empty={initial ? "Reading…" : "No variables are defined."}
        rowKey={(row) => row.key}
        rows={sorter.apply(rows)}
        {...sorter}
      />
      <StatusBar panes={[`${rows.length} variable(s)`, "Values are never sent to the desktop."]} />
    </>
  );
}

function Connections({ initial, rows }: { readonly rows: Connection[]; readonly initial: boolean }) {
  const columns: Column<Connection>[] = [
    { key: "conn_id", label: "Connection", render: (row) => row.conn_id, sort: (row) => row.conn_id },
    { key: "type", label: "Type", render: (row) => row.conn_type ?? "", sort: (row) => row.conn_type ?? "" },
    { key: "host", label: "Host", render: (row) => row.host ?? "", sort: (row) => row.host ?? "" },
    { key: "schema", label: "Schema", render: (row) => row.schema ?? "", sort: (row) => row.schema ?? "" },
    { key: "login", label: "Login", render: (row) => row.login ?? "", sort: (row) => row.login ?? "" },
    { key: "port", label: "Port", numeric: true, render: (row) => row.port ?? "", sort: (row) => row.port ?? 0 },
  ];
  const sorter = useSort(columns, "conn_id");

  return (
    <>
      <ListView
        columns={columns}
        empty={initial ? "Reading…" : "No connections are defined."}
        rowKey={(row) => row.conn_id}
        rows={sorter.apply(rows)}
        {...sorter}
      />
      <StatusBar panes={[`${rows.length} connection(s)`, "Passwords and extras are never sent to the desktop."]} />
    </>
  );
}


/**
 * The Sounds applet. Every sound is synthesised from oscillators at play time - there
 * are no audio files in this project - so "Test" is the only way to hear one.
 */
function Sounds() {
  const [enabled, setEnabled] = useState(sound.enabled);
  // Re-read on every render tick so the readout follows the real context state.
  const [, bump] = useState(0);
  const diag = sound.diagnostics();
  const [selected, setSelected] = useState<SoundName>("boot");

  type Row = (typeof SOUND_EVENTS)[number];

  const columns: Column<Row>[] = [
    { key: "event", label: "Event", render: (row) => row.description, sort: (row) => row.description },
    { key: "sound", label: "Sound", render: (row) => row.label, sort: (row) => row.label },
  ];
  const sorter = useSort(columns, "event");
  const current = SOUND_EVENTS.find((row) => row.name === selected);

  return (
    <>
      <ListView
        columns={columns}
        onActivate={(row) => sound.play(row.name)}
        onSelect={(row) => setSelected(row.name)}
        rowKey={(row) => row.name}
        rows={sorter.apply([...SOUND_EVENTS])}
        selectedKey={selected}
        {...sorter}
      />

      <div className="aos-row" style={{ flex: "none", padding: "6px 0 2px" }}>
        <label className="aos-row" style={{ gap: 4 }}>
          <input
            checked={enabled}
            onChange={(event) => {
              sound.setEnabled(event.target.checked);
              setEnabled(event.target.checked);
            }}
            type="checkbox"
          />
          Enable the Airflow OS sound scheme
        </label>
        <div className="aos-grow" />
        <Button disabled={!enabled || !current} onClick={() => (current ? sound.play(current.name) : undefined)}>
          Test
        </Button>
      </div>

      <fieldset className="aos-groupbox" style={{ flex: "none" }}>
        <legend>Diagnostics</legend>
        <div className="aos-row" style={{ justifyContent: "space-between" }}>
          <span style={{ color: "var(--text-disabled)" }}>Sound scheme</span>
          <span style={{ color: diag.enabled ? undefined : "var(--st-failed)" }}>
            {diag.enabled ? "enabled" : "disabled — click the speaker in the tray"}
          </span>
        </div>
        <div className="aos-row" style={{ justifyContent: "space-between" }}>
          <span style={{ color: "var(--text-disabled)" }}>Audio context</span>
          <span style={{ color: diag.contextState === "running" ? undefined : "var(--st-failed)" }}>
            {diag.contextState}
            {diag.contextState === "suspended" ? " — click anywhere to start it" : ""}
          </span>
        </div>
        <div className="aos-row" style={{ justifyContent: "space-between" }}>
          <span style={{ color: "var(--text-disabled)" }}>Startup chime</span>
          <span>{diag.startupPlayed ? "played this session" : "not played yet"}</span>
        </div>
        <div className="aos-row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
          <Button
            onClick={() => {
              sound.unlock();
              sound.play("asterisk");
              bump((value) => value + 1);
            }}
          >
            Play a test sound
          </Button>
        </div>
      </fieldset>

      <StatusBar
        panes={[
          current ? `${current.label} — plays when ${current.description.toLowerCase()}` : "",
          "Synthesised, not sampled",
        ]}
      />
    </>
  );
}


/** The Display applet. One setting so far: whether a failure takes the screen. */
function Display() {
  const desktop = useDesktop();
  const [bsod, setBsod] = useState(() => readFlag("bsod", true));

  return (
    <>
      <div className="aos-grow aos-scroll">
        <fieldset className="aos-groupbox">
          <legend>Stop screen</legend>
          <label className="aos-row" style={{ gap: 5 }}>
            <input
              checked={bsod}
              onChange={(event) => {
                writeFlag("bsod", event.target.checked);
                setBsod(event.target.checked);
              }}
              type="checkbox"
            />
            Show a stop screen when a task fails
          </label>
          <div style={{ color: "var(--text-disabled)", lineHeight: 1.5, marginTop: 8 }}>
            The screen prints the failed task and the last exception from its log. Any key
            returns to the desktop; Ctrl+Alt+Del clears the dag run so the scheduler tries
            it again. Only fresh failures raise it - a database full of old ones stays quiet.
          </div>
          <div className="aos-row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
            <Button
              onClick={() =>
                desktop.crash(
                  crashFor(
                    {
                      dagId: "airflow_os_demo_failure",
                      maxTries: 0,
                      runId: "manual__test",
                      state: "failed",
                      taskId: "parse_prices",
                      tryNumber: 1,
                    },
                    "ValueError: could not convert string to float: 'n/a'",
                  ),
                )
              }
            >
              Test
            </Button>
          </div>
        </fieldset>
      </div>
      <StatusBar panes={["Settings are stored in this browser only."]} />
    </>
  );
}
