# Development Workflow

This document describes the full workflow for the Movida project — from local development to cloud production.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Environment Overview](#environment-overview)
- [Env & Secrets Files](#env--secrets-files)
- [Daily Development Workflow](#daily-development-workflow)
- [Branching Strategy](#branching-strategy)
- [Deployment](#deployment)
  - [Staging Local](#staging-local-docker-compose)
  - [Staging Remote](#staging-remote-fly--neon--cloudflare)
  - [Production Remote](#production-remote-fly--neon--cloudflare)
- [Scenario Environment](#scenario-environment)
- [Testing](#testing)
- [Performance Testing](#performance-testing)
- [Safety Features](#safety-features)
- [Task Commands Reference](#task-commands-reference)
- [Port Reference](#port-reference)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

```bash
# macOS
brew install go-task/tap/go-task  # Taskfile runner
brew install flyctl               # Fly.io CLI
brew install gh                   # GitHub CLI
brew install act                  # Local CI runner (optional)

# Verify
task --version && fly version && gh --version && docker --version
```

---

## Quick Start

```bash
git clone <repository-url>
cd salsa-events-calendar
task install          # install Python venv + npm deps
task start:dev        # DB + backend (--reload) + frontend (vite)
```

- Frontend: <http://localhost:5173\>
- Backend: <http://localhost:8001/docs\>
- Umami: <http://localhost:3100\>

---

## Environment Overview

| Environment | Purpose | DB | Backend | Frontend |
|-------------|---------|------|---------|----------|
| **dev** | Local development, hot-reload | localhost:5434 | localhost:8001 | localhost:5173 |
| **staging:local** | Docker-compose integration test | localhost:5436 | localhost:8002 | localhost:3001 |
| **staging:remote** | Cloud staging (Fly.io + Neon + Cloudflare) | Neon develop | movida-staging.fly.dev | develop.joinmovida.com (alias: develop.movida.pages.dev) |
| **prod:remote** | Cloud production | Neon main | movida.fly.dev | joinmovida.com (alias: movida.pages.dev) |
| **scenario** | Isolated manual QA with seeded data | localhost:5437+ | localhost:8003+ | localhost:3002+ |

---

## Env & Secrets Files

Each environment tier loads exactly its own files — no file appears in two tiers.

| File | Committed | Loaded by |
|------|-----------|-----------|
| `secrets.env` | no | all tasks (shared base: Cloudflare creds, Google SA file) |
| `secrets.dev.env` | no | dev tasks |
| `.env.dev` | yes | dev tasks (non-secret: ports, DB name) |
| `.env.staging.local` | yes | `staging:local` tasks only — `DATABASE_URL` → localhost:5436 |
| `secrets.staging.remote.env` | no | `staging:remote` tasks only — `DATABASE_URL` → Neon develop |
| `secrets.prod.env` | no | `prod:remote` tasks |
| `.env.prod` | yes | prod tasks (non-secret) |
| `secrets.scenario.env` | no | scenario tasks |
| `.env.scenario` | yes | scenario tasks |

> **Rule:** `DATABASE_URL` is never shared between local and remote staging.
> Local tasks read it from `.env.staging.local` (localhost). Remote tasks read it from `secrets.staging.remote.env` (Neon).

---

## Daily Development Workflow

### 1. Start your day

```bash
git checkout develop && git pull origin develop
task git:feature -- my-feature-name
```

### 2. Start development environment

```bash
task start:dev          # DB + backend (reload) + frontend
task start:dev:debug    # same + debugpy on port 5678
task start:dev:mock     # same but with mock calendar (no Google creds needed)
```

Add `BROWSERS=N` to any `start:*` command that opens a browser to control how many browser instances open. `BROWSERS=0` (default) reuses your existing Chrome window; `BROWSERS=N` opens N fresh, fully-isolated Chrome sessions (separate cookie jar and localStorage — useful for testing multi-user flows):

```bash
task start:dev BROWSERS=1          # one fresh isolated session
task start:dev BROWSERS=3          # three isolated sessions at once
SCENARIO=share-im-going task start:scenario BROWSERS=2
```

### 3. Attach VSCode Debugger

Press `F5` → select **"Backend: Attach"** or **"Full Stack Debug"**.

### 4. Run Tests

```bash
task test               # quick unit tests
task test:unit:backend  # backend only
task test:unit:frontend # frontend type check + build
```

### 5. Commit and Create PR

```bash
git add . && git commit -m "feat: my feature"
task git:pr             # push + open draft PR (auto-detects target branch)
```

### 6. End of day

```bash
task stop:dev
```

---

## Branching Strategy

```
main (production)
└── hotfix/*     → PR directly to main

develop (integration)
├── feature/*    → PR to develop
└── fix/*        → PR to develop
```

| Type | Base | Command |
|------|------|---------|
| `feature/*` | develop | `task git:feature -- <name>` |
| `fix/*` | develop | `task git:fix -- <name>` |
| `hotfix/*` | main | `task git:hotfix -- <name>` |

---

## Deployment

### Staging Local (docker-compose)

Validates the Docker images in a fully containerised stack before pushing to cloud.

```bash
task deploy:staging:local                    # build from develop branch
task deploy:staging:local:ref -- feature/x  # build from any git ref
task deploy:staging:local:dirty             # build from working directory (uncommitted)

DRY_RUN=1 task deploy:staging:local        # preview without executing
```

Env files loaded: `secrets.env` + `.env.staging.local`

---

### Staging Remote (Fly + Neon + Cloudflare)

**Full deploy (all three components in sequence):**

```bash
task deploy:staging:remote
```

**Deploy only one component:**

```bash
task deploy:staging:remote:db        # alembic migrations → Neon develop branch
task deploy:staging:remote:backend   # stage Fly secrets + fly deploy + smoke test
task deploy:staging:remote:frontend  # build frontend + wrangler pages deploy --branch=develop
```

Env files loaded: `secrets.env` + `secrets.staging.remote.env`

What `backend:staging:remote` does:
1. `fly secrets import -c config/fly.staging.toml --stage` (filtered: no `VITE_*`, no `CLOUDFLARE_*`)
2. `fly secrets set --stage GOOGLE_SERVICE_ACCOUNT_JSON=...`
3. `fly deploy --remote-only -c config/fly.staging.toml` (staged secrets + code applied atomically)
4. Smoke test: `GET https://movida-staging.fly.dev/health`

URLs after deploy:
- Backend: <https://movida-staging.fly.dev\>
- Frontend: <https://develop.joinmovida.com\> (alias: <https://develop.movida.pages.dev\>)

Verify:
```bash
task db:check:staging:remote    # migration state on Neon develop
task logs:staging:remote        # fly logs stream
task fly:staging:status         # machine status
```

---

### Production Remote (Fly + Neon + Cloudflare)

**Full deploy (prompts for confirmation):**

```bash
task deploy:prod:remote
```

**Deploy only one component:**

```bash
task deploy:prod:remote:db        # alembic migrations → Neon main branch
task deploy:prod:remote:backend   # stage Fly secrets + fly deploy + smoke test
task deploy:prod:remote:frontend  # build frontend + wrangler pages deploy --branch=main
```

Env files loaded: `secrets.env` + `secrets.prod.env` + `.env.prod`

URLs after deploy:
- Backend: <https://movida.fly.dev\>
- Frontend: <https://joinmovida.com\> (alias: <https://movida.pages.dev\>)

Verify:
```bash
task db:check:prod
task fly:logs
task fly:status
```

**Release flow (local prod via docker-compose):**

```bash
task git:release:prepare    # create develop → main PR
task git:release:ready      # mark ready for review
task git:release:merge      # merge
task git:release:tag -- v1.2.0
task deploy:prod -- v1.2.0  # docker-compose local prod
```

---

## Scenario Environment

Isolated full stack with per-scenario seeded data. Useful for manual QA, demos, and feature validation without touching dev or staging.

### Scenario folder structure

```
scenarios/<name>/
├── config.yaml           # Required: calendar_service (google|mock)
├── calendars.yaml        # Optional
├── events.yaml           # Optional: events pre-seeded into DB
└── secrets.env           # Optional: per-scenario secret overrides (gitignored)
```

### Lifecycle

```bash
task start:scenario                                       # default scenario (local code + Docker DB)
SCENARIO=locations-map task start:scenario                # named scenario (own DB + ports)
SCENARIO=share-im-going task start:scenario BROWSERS=1    # open one fresh isolated Chrome session
SCENARIO=share-im-going task start:scenario BROWSERS=2    # open two isolated sessions (multi-user)

# From a git ref (all-Docker)
task start:scenario:ref -- feature/my-branch

# DB operations
SCENARIO=locations-map task db:seed:scenario
SCENARIO=locations-map task db:reset:scenario

# Logs & teardown
SCENARIO=locations-map task logs:scenario
SCENARIO=locations-map task stop:scenario
task stop:scenario:all
```

Ports are deterministic per scenario name. Run `task scenarios` to see all assignments.

---

## Testing

```bash
task test               # unit tests (fast)
task test:unit:backend  # backend unit + API tests
task test:unit:frontend # frontend type check + build
task test:int           # integration tests (requires task db:setup:integ first)
task test:int:full      # setup → test in one command
task test:all           # unit + integration
task test:ci            # simulate CI locally via Act
```

---

## Performance Testing

Load tests are written in [k6](https://k6.io) and live under `perf/k6/`.
Profiles live in `perf/k6/profiles/*.env`. Per-developer tweaks go in a sibling `*.override.env` (gitignored), and ad-hoc CLI envs (e.g. `VUS=10 task perf:staging`) win over both.

```bash
brew install k6
task perf:check            # verify k6 is installed
```

### Layout

```
perf/
├── k6/
│   ├── main.js                 # browse_events + sitemap_seo scenarios
│   └── profiles/
│       ├── dev.env             # localhost:8001
│       ├── perf.env            # perf scenario (BASE_URL auto-injected)
│       ├── staging.env         # https://api-develop.joinmovida.com
│       └── prod.env            # https://api.joinmovida.com (smoke only)
└── results/                    # summary-*.html / summary-*.json
```

### Recommended local workflow (perf scenario)

The perf scenario is just another entry under `scenarios/` — it reuses the
standard scenario harness for an isolated DB, deterministic ports, mock
calendar, seeded events, and a rate-limit kill switch (`RATE_LIMIT_ENABLED=false`
in [scenarios/perf/config.env](scenarios/perf/config.env)).

```bash
# terminal 1 — boot the perf scenario (foreground, blocking)
task perf:scenario:up

# terminal 2 — run k6 (auto-derives BASE_URL from .taskfiles/.scenario-state/perf.env)
task perf:run
task perf:report           # open the HTML summary in your browser

# terminal 1 — Ctrl-C, then drop the DB:
task perf:scenario:down
```

### Other targets

| Command | Description |
|---------|-------------|
| `task perf:dev` | Run against an ad-hoc dev backend (`localhost:8001`). |
| `task perf:staging` | Run against remote staging (`https://api-develop.joinmovida.com`, 15 VUs × 5m). Staging is rate-limited unless `RATE_LIMIT_ENABLED=false` is set on the Fly app, so expect 429s in default profile. |
| `task perf:prod:smoke` | Read-only smoke against production (5 VUs × 2m). |
| `task perf:scenario:logs` | Tail the perf scenario backend logs. |
| `task perf:report` | Open `perf/results/summary-latest.html`. |
| `task perf:clean` | Remove old summary files. |

### Overriding BASE_URL or VUs

Three precedence levels (each wins over the previous):

1. Committed profile: `perf/k6/profiles/<profile>.env`
2. Per-developer overrides: `perf/k6/profiles/<profile>.override.env` (gitignored)
3. CLI envs: `VUS=15 DURATION=2m KILL_LIMITER=1 task perf:staging`

Supported CLI overrides: `VUS`, `DURATION`, `RAMP`, `THINK_MIN`, `THINK_MAX`, `BASE_URL`.

```bash
# Quick ad-hoc tweak (no file edits):
VUS=15 DURATION=2m KILL_LIMITER=1 task perf:staging

# Persistent personal override:
cat > perf/k6/profiles/staging.override.env <<'EOF'
VUS=5
DURATION=1m
EOF
task perf:staging
```

---

## Safety Features

All destructive operations support `DRY_RUN=1` to preview without executing:

```bash
DRY_RUN=1 task deploy:staging:local
DRY_RUN=1 task db:reset:dev
DRY_RUN=1 task stop:dev:volumes
```

Tasks that prompt for confirmation before executing:
- All `db:reset:*`
- All `stop:*:volumes`
- `deploy:prod:remote`
- `deploy:prod`
- `stop:scenario`, `stop:scenario:all`

---

## Task Commands Reference

### Development

| Command | Description |
|---------|-------------|
| `task start:dev` | DB + backend (reload) + frontend |
| `task start:dev BROWSERS=1` | Same, opens one fresh isolated Chrome session |
| `task start:dev BROWSERS=N` | Same, opens N fresh isolated Chrome sessions |
| `task start:dev:debug` | Same + debugpy on port 5678 |
| `task start:dev:mock` | Same with mock calendar (no Google creds) |
| `task start:dev:db` | Dev database only |
| `task start:dev:backend` | Backend only |
| `task start:dev:frontend` | Frontend only |
| `task stop:dev` | Stop all dev services |
| `task stop:dev:volumes` | Stop dev + destroy DB data ⚠️ |

### Deploy — Staging Remote (atomic)

| Command | Description |
|---------|-------------|
| `task deploy:staging:remote:db` | Alembic migrations → Neon develop |
| `task deploy:staging:remote:backend` | Stage secrets + fly deploy + smoke test |
| `task deploy:staging:remote:frontend` | Build + wrangler pages deploy --branch=develop |
| `task deploy:staging:remote` | All three in sequence |

### Deploy — Prod Remote (atomic)

| Command | Description |
|---------|-------------|
| `task deploy:prod:remote:db` | Alembic migrations → Neon main |
| `task deploy:prod:remote:backend` | Stage secrets + fly deploy + smoke test |
| `task deploy:prod:remote:frontend` | Build + wrangler pages deploy --branch=main |
| `task deploy:prod:remote` | All three in sequence (prompts) |

### Deploy — Staging Local (docker-compose)

| Command | Description |
|---------|-------------|
| `task deploy:staging:local` | Build from develop + docker-compose up |
| `task deploy:staging:local:ref -- <ref>` | Build from git ref + docker-compose up |
| `task deploy:staging:local:dirty` | Build from working directory + docker-compose up |
| `task start:staging:local BROWSERS=1` | Same, opens one fresh isolated Chrome session |
| `task start:staging:local BROWSERS=N` | Same, opens N fresh isolated Chrome sessions |
| `task start:staging:local` | Start staging with existing images |
| `task stop:staging:local` | Stop staging stack |
| `task stop:staging:local:volumes` | Stop + destroy data ⚠️ |

### Database

| Command | Description |
|---------|-------------|
| `task db:migrate` | Dev — alembic upgrade head |
| `task db:migrate:staging:local` | Local staging DB |
| `task db:migrate:staging:remote` | Neon develop branch |
| `task db:migrate:prod` | Neon main branch |
| `task db:seed` | Seed dev DB |
| `task db:seed:staging:local` | Seed local staging DB |
| `task db:seed:staging:remote` | Seed Neon staging (prompts) |
| `task db:seed:prod` | Seed Neon prod (prompts) |
| `task db:check:dev` | Connectivity + migration state |
| `task db:check:staging:local` | Local staging |
| `task db:check:staging:remote` | Neon develop |
| `task db:check:prod` | Neon main |
| `task db:reset:dev` | Drop + remigrate + reseed dev ⚠️ |
| `task db:reset:staging:local` | Local staging ⚠️ |
| `task db:reset:staging:remote` | Neon develop ⚠️ |
| `task db:reset:prod` | Neon main 🚨 |
| `task db:status:dev` | Alembic current/history |
| `task db:status:staging:remote` | Neon develop |
| `task db:status:prod` | Neon main |

### Fly.io Operations

| Command | Description |
|---------|-------------|
| `task fly:status` | Prod machine status |
| `task fly:logs` | Stream prod logs |
| `task fly:ssh` | SSH into prod machine |
| `task fly:secrets` | Push secrets to prod Fly (standalone) |
| `task fly:secrets:list` | List prod secret names |
| `task fly:staging:status` | Staging machine status |
| `task fly:staging:logs` | Stream staging logs |
| `task fly:staging:ssh` | SSH into staging machine |
| `task fly:staging:secrets` | Push secrets to staging Fly (standalone) |
| `task fly:staging:secrets:list` | List staging secret names |

### Scenario

| Command | Description |
|---------|-------------|
| `task start:scenario` | Local code + Docker DB + live reload |
| `task start:scenario BROWSERS=1` | Same, opens one fresh isolated Chrome session |
| `task start:scenario BROWSERS=N` | Same, opens N fresh isolated Chrome sessions |
| `task start:scenario:ref -- <ref>` | All-Docker from git ref |
| `task stop:scenario` | Stop one scenario |
| `task stop:scenario:all` | Stop all running scenarios |
| `task db:seed:scenario` | Seed scenario DB |
| `task db:reset:scenario` | Reset scenario DB ⚠️ |
| `task logs:scenario` | Tail scenario logs |

All scenario commands accept `SCENARIO=<name>`.

### Git & Release

| Command | Description |
|---------|-------------|
| `task git:feature -- <name>` | Create feature branch from develop |
| `task git:fix -- <name>` | Create fix branch from develop |
| `task git:hotfix -- <name>` | Create hotfix branch from main |
| `task git:pr` | Push + create draft PR |
| `task git:pr:ready` | Mark draft as ready |
| `task git:pr:checks` | Show CI status |
| `task git:pr:merge` | Squash merge |
| `task git:release:prepare` | Create develop → main release PR |
| `task git:release:tag -- v1.0.0` | Tag release on main |
| `task release -- v1.0.0` | Tag + local prod deploy |

### Build

| Command | Description |
|---------|-------------|
| `task build:staging` | Build images from develop |
| `task build:prod -- v1.0.0` | Build from main |
| `task build:ref -- <ref>` | Build from any git ref |
| `task build:dirty` | Build from working directory |
| `task build:list` | List Docker images |
| `task build:clean` | Remove old images |

### Testing

| Command | Description |
|---------|-------------|
| `task test` | Quick unit tests |
| `task test:unit` | Full unit suite |
| `task test:int` | Integration tests |
| `task test:int:full` | Setup + integration |
| `task test:all` | All tests |
| `task test:ci` | Simulate CI via Act |

### Performance (k6)

| Command | Description |
|---------|-------------|
| `task perf:check` | Verify k6 is installed |
| `task perf:scenario:up` | Start the perf scenario (delegates to `start:scenario SCENARIO=perf`) |
| `task perf:scenario:down` | Stop perf scenario, drop DB |
| `task perf:scenario:logs` | Tail perf scenario logs |
| `task perf:run` | Run k6 against the running perf scenario (auto-port) |
| `task perf:dev` | Run k6 against `localhost:8001` |
| `task perf:staging` | Run k6 against remote staging |
| `task perf:prod:smoke` | Read-only smoke against prod (5 VUs × 2m) |
| `task perf:report` | Open the latest HTML summary |
| `task perf:clean` | Remove old summary files |

### Utilities

| Command | Description |
|---------|-------------|
| `task install` | Install all dependencies |
| `task status` | Show running containers |
| `task scenarios` | List scenario instances + ports |
| `task help` | Quick reference |

---

## Port Reference

| Service | dev | staging:local | scenario (default) | prod (local) |
|---------|-----|--------------|---------------------|--------------|
| PostgreSQL | 5434 | 5436 | 5437 | 5438 |
| Backend | 8001 | 8002 | 8003 | 8080 |
| Frontend | 5173 | 3001 | 3002 | 3000 |
| Debugger | 5678 | — | — | — |
| Umami | 3100 | — | — | — |

> Scenario ports are deterministic per scenario name (hash-based offset). Run `task scenarios` to see all current assignments.

---

## Troubleshooting

### DATABASE_URL not set

Each remote task reads its `DATABASE_URL` from its own secrets file:
- `staging:remote` tasks → `secrets.staging.remote.env`
- `prod:remote` tasks → `secrets.prod.env`

Copy the `.example` file and fill in the Neon connection string from the dashboard.

### Cloudflare authentication failed

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` live in `secrets.env` (shared). The token needs **Account → Cloudflare Pages → Edit** permission.

### Database connection failed

```bash
docker ps | grep calendar_db_dev   # check container is running
task start:dev:db                  # start it
task db:check:dev                  # verify connectivity
```

### Port already in use

```bash
lsof -i :8001    # find what's using the port
kill -9 <PID>
```

### Fly machine not responding after deploy

```bash
task fly:staging:status   # check machine state
task logs:staging:remote  # stream logs
task fly:staging:ssh      # SSH in to debug
```

### Reset everything

```bash
task stop:dev && task stop:staging:local
DRY_RUN=1 task stop:dev:volumes          # preview first
task stop:dev:volumes                    # then confirm
```
