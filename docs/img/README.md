# README images

`icons.svg`, `pinwheel.svg` and `splash.svg` are generated from source, so they cannot
drift from what the desktop actually renders. Regenerate them with `scripts/gen-assets.mjs`.
The splash is the README's masthead: the boot screen's sky, pinwheel and wordmark as one
animated SVG, since GitHub keeps declarative animation when it renders an image.

The screenshots below have to be taken by hand. Sizes are suggestions — what matters
is that no window is cropped and the taskbar is visible, since it is part of the joke.

| File | Shot | Notes |
| --- | --- | --- |
| `desktop.png` | The whole desktop, wide | Two or three windows open and overlapping. This is the hero image; make it the best one. |
| `taskmanager.png` | Task Manager, Processes tab | Trigger a few dags first so the list is full and the CPU column has numbers. |
| `explorer.png` | Explorer at `C:\<dag>\<run>` | Deep enough to show the folder metaphor working. |
| `clippy.png` | Clippy showing a verdict | Needs a model connection. Run `airflow_os_demo_failure` first. |
| `bsod.png` | The stop screen | `Control Panel → Display → Test`, or trigger `airflow_os_demo_failure`. |
| `hitl.png` | Human Input Required | Trigger `example_hitl_operator`; catch it with a request pending. |
| `deadlines.png` | Deadlines mailbox | Trigger `airflow_os_demo_deadline` and wait ~40s for the miss. |
| `recyclebin.png` | Recycle Bin | Delete a dag file and wait for the dag-processor to mark it stale. |
| `help.png` | Airflow Help | Filter to `bash_operator` — that dag's `doc_md` exercises headings, bold and bullets. |
| `terminal.png` | MS-DOS Prompt | Run `tasklist` so there is output on screen. |
| `paint.png` | Paint | Open `airflow_os_demo_failure` after a run: green, red and a dithered `upstream_failed` in one picture. Zoom 200% so the pixels read. |

On macOS: **⌘⇧4** then space to capture a single window, or drag for a region.
