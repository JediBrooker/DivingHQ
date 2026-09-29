# Observability stack

Logs (Loki) + metrics (Prometheus) + UI (Grafana), all running in
Docker on the same VPS as the dive-recorder app. Everything is
configured by files in this directory; no click-ops.

```
┌─────────────────────────────────────────────────────────────┐
│  dive-recorder app  (PM2, port 3000)                        │
│   ├── Pino → stdout / logs/pm2-out.log  ─────► Promtail ──► Loki ──┐
│   └── /metrics endpoint  ◄──────────  Prometheus (scrape every 30s) │
│                                                                    │
│                               Grafana (port 3030, localhost only)  ◄┘
└─────────────────────────────────────────────────────────────┘
```

## Prerequisites

* Docker + Compose v2 installed (`docker compose version` works).
* The dive-recorder app already running on port 3000 (the default).
* The PM2 ecosystem writes logs to the project's `./logs/`
  directory (already configured in `ecosystem.config.js`).

## First-time setup

```bash
# From the repo root
cd ops/observability

# Optional: pick a real Grafana admin password + decide where
# Grafana should listen. Defaults are 127.0.0.1 (server-only —
# reach via SSH tunnel) and "change-me-on-first-login".
cat > .env <<EOF
GRAFANA_ADMIN_PASSWORD=your-strong-password-here

# Pick ONE of:
#   GRAFANA_BIND_ADDR=127.0.0.1     # default — loopback only,
#                                   # use SSH tunnel from your laptop
#   GRAFANA_BIND_ADDR=0.0.0.0       # LAN / WAN-reachable; only safe
#                                   # behind a firewall or private NAT
#   GRAFANA_BIND_ADDR=192.168.0.117 # bind to one specific interface
EOF

# Bring all four services up. First boot pulls images (~400MB total).
docker compose up -d

# Wait ~10 seconds for everything to start, then verify
docker compose ps
```

You should see four containers in state `running`:

```
NAME                          STATUS
dive-recorder-grafana         Up
dive-recorder-loki            Up
dive-recorder-prometheus      Up
dive-recorder-promtail        Up
```

## Accessing Grafana

Three options, pick the one that matches your setup:

### Option A — SSH tunnel (default; works for any setup)

Use this when `GRAFANA_BIND_ADDR=127.0.0.1` (the default).

```bash
# On your laptop, leave this running
ssh -N -L 3030:127.0.0.1:3030 you@your-server
# Now open http://localhost:3030 in your browser
```

### Option B — LAN-reachable (private network)

Use this when the server is on a private LAN (e.g. `192.168.x.y`,
`10.x.y.z`) and you want any device on the LAN to open Grafana
directly. Set in `.env`:

```
GRAFANA_BIND_ADDR=0.0.0.0
```

`docker compose up -d` to apply. Then open
`http://<server-LAN-IP>:3030` from your laptop / phone / tablet.
Loki, Prometheus and Promtail STAY 127.0.0.1-bound — only Grafana
becomes LAN-visible, because Grafana proxies the others
internally via the docker network.

DO NOT set this if the server is also on a public IP without a
firewall — Grafana with default creds is a bad day. Stick to
Option A in that case, or use Option C.

### Option C — Cloudflare Tunnel

If you already use Cloudflare in front of the app, add a second
hostname (e.g. `grafana.example.com`) pointing to `localhost:3030`
and gate it with a Cloudflare Access policy. Keep
`GRAFANA_BIND_ADDR=127.0.0.1` so the only public reach is via the
authenticated tunnel.

---

In all cases, log in as `admin` / the password you set in `.env`
(or `change-me-on-first-login` if you skipped it). Change it on
first login regardless.

## What's already configured

* **Two datasources** — Prometheus (default) and Loki — auto-loaded
  via `grafana/provisioning/datasources/all.yml`. No need to add
  them through the UI.
* **One starter dashboard** at `Dashboards → DivingHQ → Dive
  Recorder`, with nine panels:
  * Score submissions / minute (stat)
  * Connected sockets (stat)
  * DB pool waiting (stat — saturation signal)
  * Scoreboard cache hit ratio (stat)
  * HTTP request rate by route (timeseries)
  * HTTP latency p50 / p95 / p99 (timeseries)
  * Accepted vs rejected score submissions (timeseries)
  * Process resident memory (timeseries)
  * Recent application logs (live tail with structured-field
    inspection)

## Useful Grafana queries

Once you're past the starter dashboard, the four queries you'll
re-use day-to-day:

| Question | Query |
|---|---|
| Are scores landing? | `rate(dive_recorder_scores_submitted_total[1m]) * 60` |
| Which routes are slow? | `histogram_quantile(0.95, sum by (le, route) (rate(dive_recorder_http_request_duration_seconds_bucket[5m])))` |
| Is the DB pool saturated? | `dive_recorder_db_pool_waiting` |
| Are there errors right now? | (Loki) `{job="dive-recorder"} \| json \| level="error"` |

## Day-2 operations

```bash
# Tail Loki ingestion
docker compose logs -f loki

# Restart just one service after a config edit
docker compose restart promtail

# Stop everything (data persists in named volumes)
docker compose down

# Wipe everything including history
docker compose down -v

# Upgrade to a new image version — bump in docker-compose.yml,
# then:
docker compose pull
docker compose up -d
```

## Disk usage

Bounded by:

* Loki: 30-day retention (`limits_config.retention_period: 720h`
  in `loki/local-config.yaml`)
* Prometheus: 30-day retention
  (`--storage.tsdb.retention.time=30d` in `docker-compose.yml`)

For a single VPS with light meet activity that's typically
~1-2GB. Keep an eye on `df -h /var/lib/docker/volumes/` if you
ever extend either retention window.

## Security notes

* `/metrics` on the app. Prometheus reaches it directly via
  `host.docker.internal:3000` from the same box. A firewall on port
  3000 does **not** keep the internet out on its own: a Cloudflare
  Tunnel forwards every path of the public hostname to the app,
  `/metrics` included. So the app refuses, with a plain 404, any
  `/metrics` request that came through Cloudflare (it carries
  `cf-ray` or `cf-connecting-ip`) unless it has the
  `METRICS_TOKEN` bearer. Direct scrapes carry no Cloudflare
  headers, so the tokenless setup (`METRICS_PUBLIC=true` in
  production) keeps working. See `lib/metrics-access.js`.

  Check it from anywhere off the box:

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' https://divinghq.app/metrics   # 404
  ```

  and on the box (still 200 for Prometheus):

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/metrics  # 200
  ```

  To also lock the direct path (anything on the LAN that can reach
  port 3000), set `METRICS_TOKEN` in the app's `.env`, drop
  `METRICS_PUBLIC`, restart the app, and give Prometheus the token:
  put it in a file next to `prometheus.yml`, mount it read-only
  into the container (e.g. `./prometheus/metrics-token:/etc/prometheus/metrics-token:ro`
  under the prometheus service's `volumes`), and add this to the
  `dive_recorder` job:

  ```yaml
      authorization:
        type: Bearer
        credentials_file: /etc/prometheus/metrics-token
  ```

  then `docker compose up -d prometheus`. Keep the token file out
  of git.
* Grafana's admin password is read from `.env` next to this
  compose file (or defaults to `change-me-on-first-login`). Don't
  commit `.env`.
* Loki + Prometheus + Grafana ports are bound to `127.0.0.1` only,
  so they're not internet-reachable without an SSH tunnel or
  Cloudflare Access.
