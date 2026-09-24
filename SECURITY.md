# Security

Airflow OS is a plugin that runs **inside the Airflow api-server process**, with that
process's privileges. A bug here is a bug in something privileged, so please report one
rather than filing it in public.

## Reporting a vulnerability

Email **roykoand@gmail.com**. Please do not open a public issue, a pull request or a
discussion for anything you believe is exploitable.

Useful things to include, as far as you have them:

- what an attacker gets — data they should not see, a write they should not be able to
  make, code execution, a way to escalate past Airflow's own access checks;
- the Airflow version, the auth manager in use, and how Airflow OS was installed
  (`pip install`, the Docker image, something else);
- the smallest reproduction you can manage, and a rough idea of how a real deployment
  would be exposed to it.

This is a personal project maintained by one person, so I cannot promise a response
time. I will acknowledge a report as soon as I read it, tell you plainly whether I think
it is a real issue, and credit you when a fix ships unless you would rather I did not.

## Supported versions

Fixes land on `main`. There is no separate maintenance branch, and no backports to
earlier tags.

## What this project already tries to do

Worth knowing before you report, and worth testing if you want to look for a hole:

- **Reads go through Airflow's own REST API, as the caller.** The plugin replays the
  credential the browser arrived with against `/api/v2`, so Airflow's permission checks
  decide what is visible rather than the plugin reimplementing them. A request with no
  credential is refused rather than falling back to a service account.
- **Secrets are dropped before they reach the browser.** `/api/v2` will hand a
  sufficiently privileged caller a connection's password and `extra` and a variable's
  value. Control Panel lists names and shapes only, and discards all three in the
  api-server.
- **A refusal stays a refusal.** A 401 or 403 from the core API is forwarded, never
  turned into an empty window that would read as "there is nothing here".
- **Writes go through `/api/v2` too**, so they inherit Airflow's validation and audit
  trail. The one remaining direct database read is the Deadlines view, because Airflow
  publishes no deadline endpoints at all.
- **Dag documentation is rendered as React elements, not HTML.** `doc_md` is written by
  whoever writes the dag; injecting it as HTML would hand them a script tag in another
  user's Airflow session.

## The Docker image is a demo, not a deployment

`docker-compose.yml` deliberately pins a known JWT signing secret and a known Fernet
key, and seeds an `admin` / `admin` login, so that sessions and encrypted values survive
a rebuild on a laptop. It also runs `airflow standalone` on SQLite.

That box is meant to be reachable only by you. Please do not report the fixed
credentials as a vulnerability — they are documented as development values in the
README, and every one of them is overridable by an environment variable. If you find a
way to reach something through the plugin that Airflow's own UI would have refused you,
that **is** worth reporting.
