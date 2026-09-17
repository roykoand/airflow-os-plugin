/**
 * Per-browser desktop preferences.
 *
 * Deliberately tiny and deliberately forgiving: every accessor can throw (private
 * windows, blocked site data), and a missing preference must never stop the desktop
 * rendering. Anything that needs to be shared between people belongs in Airflow, not
 * here.
 */

export function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(`airflow-os:${key}`);
    if (raw === null || raw === undefined) return fallback;
    return raw === "on";
  } catch {
    return fallback;
  }
}

export function writeFlag(key: string, value: boolean): void {
  try {
    globalThis.localStorage?.setItem(`airflow-os:${key}`, value ? "on" : "off");
  } catch {
    // The preference just will not persist.
  }
}
