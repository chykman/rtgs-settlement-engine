# Drill solutions (read only after you have a root cause)

| # | Cause | How to prove it | Detection gap to discuss |
|---|-------|-----------------|--------------------------|
| 1 | Core container stopped (`docker compose stop`) - stopped by an operator, so the `restart:` policy deliberately does not restart it | `docker compose ps -a`, exit code 0 vs 137; `docker events` shows `die` then no `start` | Gateway returns 503 correctly, but nothing alerts a human |
| 2 | `DATABASE_URL` points to host `db-primary`, which does not exist | `docker compose logs rtgs-core` shows ENOTFOUND; `docker inspect` RestartCount climbing; `docker compose config` shows the effective env | The service waits 30s per attempt, so the crash loop is slow and looks "stuck starting" |
| 3 | Memory limit of 24 MB: kernel OOM-kills the process (exit 137, `OOMKilled: true`) | `docker inspect -f '{{.State.OOMKilled}} {{.State.ExitCode}}' ...`; `dmesg` on the VM; `docker stats` | No application log line exists because the process was SIGKILLed, so logs alone mislead |
| 4 | Core removed from the `backend` network | `docker network inspect rtgs_backend`; from the gateway container: `wget http://rtgs-core:4000/health` fails to resolve | Health checks run inside the container, so it stays "healthy" while unreachable |
| 5 | Postgres stopped | `docker compose ps`; core `/health` returns 503 (it checks `SELECT 1`) | Core and gateway both go unhealthy; the root cause is one layer down |
| 6 | Gateway holds a different `INTERNAL_TOKEN` than the core | Gateway returns 502 `UPSTREAM_AUTH_FAILURE`; core access log / 401s; compare envs with `docker compose config` | Before the gateway fix, this surfaced to banks as a misleading 401 "your key is wrong" |

Postmortem template: summary, impact, timeline (UTC), root cause, what detected it, what should have, action items.
