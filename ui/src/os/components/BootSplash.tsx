import { useCallback, useEffect, useState } from "react";

import { kernel } from "../api/client";
import { sound } from "../kernel/sound";
import { AirflowLogo } from "./AirflowLogo";

/**
 * The boot splash, laid out the way the Windows 95 one was: a cloudy sky, the logo on
 * the left, the wordmark stacked beside it - a small line above a very large one, the
 * way "Microsoft" sat above "Windows 95" - a copyright line in the bottom corner, and
 * a progress bar along the bottom.
 *
 * The logo is Apache Airflow's own pinwheel, and pinwheels turn, so it turns. The
 * status line is real POST output: the splash asks the kernel what machine this is
 * while it waits, so by the time it clears you have been told the Airflow version,
 * the dag count and whether the scheduler is alive.
 *
 * ## About the sound
 *
 * Two sounds, not one: air while the splash is up, and a logon click as the desktop
 * takes over. The air is started here on mount, so it plays *with* the boot.
 *
 * Whether that works is not up to us: browsers refuse audio until a document has user
 * activation, and a page *load* does not grant it - only interacting with an
 * already-loaded document does. Arriving from the Airflow nav carries the activation
 * from that click, so the chime plays and nothing is asked of anyone. A hard reload
 * straight onto this route throws activation away, and then the boot is silent -
 * there is no API that changes this, so the splash does not nag about it. The
 * desktop's gesture listeners pick audio up for whatever happens next.
 */
export function BootSplash({
  minimumMs = 2600,
  onDone,
}: {
  readonly minimumMs?: number;
  readonly onDone: () => void;
}) {
  const [post, setPost] = useState("Starting Airflow OS…");

  // Clicking to skip should sound the same as booting through, so both go via here.
  const finish = useCallback(() => {
    sound.play("logon");
    onDone();
  }, [onDone]);

  // Real POST output, fetched while the splash is up either way.
  useEffect(() => {
    let cancelled = false;
    kernel
      .system()
      .then((system) => {
        if (cancelled) return;
        setPost(
          `Apache Airflow ${system.airflow_version}  ·  ${system.dags_total} dags  ·  ` +
            `scheduler ${system.scheduler_alive ? "OK" : "not responding"}`,
        );
      })
      .catch(() => {
        if (!cancelled) setPost("Could not reach the kernel");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Air while the splash is up; the logon click lands when the desktop takes over.
  // Nothing here blocks - if the browser will not allow audio yet, the boot simply
  // proceeds in silence.
  useEffect(() => {
    sound.unlock("boot");
    const timer = globalThis.setTimeout(finish, minimumMs);
    return () => globalThis.clearTimeout(timer);
  }, [finish, minimumMs]);

  return (
    <button className="aos-splash" onClick={finish} title="Click to skip" type="button">
      <div className="aos-splash-clouds" />

      <div className="aos-splash-plate">
        <AirflowLogo className="aos-splash-logo" size={190} />
        <div className="aos-splash-words">
          <div className="aos-splash-small">Apache</div>
          <div className="aos-splash-big">Airflow OS</div>
        </div>
      </div>

      <div className="aos-splash-footer">
        <div className="aos-splash-legal">
          Apache Airflow&reg; is a trademark of The Apache Software Foundation.
          <br />
          Airflow OS is a plugin. Licensed under the Apache License 2.0.
        </div>

        <div className="aos-splash-bar">
          <div className="aos-splash-bar-fill" />
        </div>

        <div className="aos-splash-post">{post}</div>
      </div>
    </button>
  );
}
