# Development Workflow

This document describes the full workflow for the Movida project — from local development to cloud production.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Environment Overview](#environment-overview)
- [Env & Secrets Files](#env--secrets-files)
- [Branching Strategy](#branching-strategy)
- [Daily Development Workflow](#daily-development-workflow)
- [Scenario Environment](#scenario-environment)
- [Testing](#testing)
- [Performance Testing](#performance-testing)
- [Deployment](#deployment)
  - [Staging Local](#staging-local-docker-compose)
  - [Staging Remote](#staging-remote-fly--neon--cloudflare)
  - [Production Remote](#production-remote-fly--neon--cloudflare)
- [Safety Features](#safety-features)
- [Common Workflows](#common-workflows)
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
| `dev.env` | yes | dev tasks (non-secret: ports, DB name) |
| `staging.local.env` | yes | `staging:local` tasks only — app config for localhost Docker |
| `staging.remote.frontend.env` | yes | `staging:remote` frontend build — VITE_API_URL, analytics |
| `secrets.staging.env` | no | `staging:remote` tasks — `DATABASE_URL` → Neon develop |
| `secrets.prod.env` | no | `prod:remote` tasks — `DATABASE_URL` → Neon main |
| `prod.remote.frontend.env` | yes | `prod:remote` frontend build — VITE_API_URL, analytics |
| `scenario.env` | yes | scenario tasks (non-secret) |
| `secrets.scenario.env` | no | scenario tasks |

> **Rule:** `DATABASE_URL` is never shared between local and remote staging.
> Local tasks read it from `staging.local.env` (localhost:5436). Remote tasks read it from `secrets.staging.env` (Neon develop).

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

See [Common Workflows](#common-workflows) for end-to-end journeys built on top of this branching model.

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

Browser control on any `start:*` command uses these parameters:
- `BROWSER=none|shared|isolated` (default `none` for `start:*`)
  - `none`     servers only, no browser action
  - `shared`   focus existing Chrome tab matching URL, else open one tab in your default Chrome profile (cookies + localStorage shared with all your normal browsing)
  - `isolated` open `COUNT` Chrome sessions, each with its own `--user-data-dir` (own cookies + localStorage; better than incognito). Idempotent: re-running focuses the existing window. Use `RESET_BROWSER=1` to wipe profile dirs first for a true clean start.
- `COUNT=N` (only used with `BROWSER=isolated`, default `1`)
- `RESET_BROWSER=1` (only used with `BROWSER=isolated`; wipes profile dirs before launching)

```bash
task start:dev                                          # servers only
task start:dev BROWSER=shared                           # focus existing dev tab
task start:dev BROWSER=isolated                         # one isolated session
task start:dev BROWSER=isolated COUNT=3                 # three isolated sessions
SCENARIO=share-im-going task start:scenario BROWSER=isolated COUNT=2
SCENARIO=foo task start:scenario BROWSER=isolated RESET_BROWSER=1   # wipe + relaunch
```

Isolated sessions live under `/tmp/chrome-profiles/<label>-<i>` and are idempotent: re-running the same task focuses the existing window instead of duplicating it. Pass `RESET_BROWSER=1` to delete the profile dir before launching. Scenario stop tasks clean their own browser profiles automatically (pass `KEEP_BROWSER=1` to opt out).

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

## Scenario Environment

Isolated full stack with per-scenario seeded data. Useful for manual QA, demos, and feature validation without touching dev or staging.

### Scenario folder structure

```
scenarios/<name>/
├── config.env            # Optional: per-scenario env, e.g. CALENDAR_SERVICE=mock
├── calendars.yaml        # Optional: calendar settings and defaults
├── db-events.yaml        # Optional: events pre-seeded directly into DB
├── mock-sync-events.yaml # Optional: mock calendar events ingested by sync
├── generated-events.yaml # Optional: deterministic bulk event fixture
├── mock-users.yaml       # Optional: scenario users
└── secrets.env           # Optional: per-scenario secret overrides (gitignored)
```

### Lifecycle

```bash
task start:scenario                                       # default scenario (local code + Docker DB)
SCENARIO=locations-map task start:scenario                # named scenario (own DB + ports)
SCENARIO=share-im-going task start:scenario BROWSER=isolated           # one isolated Chrome session
SCENARIO=share-im-going task start:scenario BROWSER=isolated COUNT=2  # two isolated sessions (multi-user)

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

Use the production-volume variant when validating Explorer/listing performance
against a data shape closer to production. It uses the same scenario harness,
but [scenarios/perf-prod-volume/generated-events.yaml](scenarios/perf-prod-volume/generated-events.yaml)
generates 1,500 cached events plus tags, views, saves, and attendances during
seeding. The generator is deterministic and idempotent, so re-seeding does not
duplicate rows.

```bash
# terminal 1 — boot the production-volume perf scenario (foreground, blocking)
task perf:scenario:up:prod-volume

# terminal 2 — run k6 against its auto-derived API port
task perf:run:prod-volume
task perf:report

# terminal 1 — Ctrl-C, then stop/drop the prod-volume scenario DB:
task stop:scenario SCENARIO=perf-prod-volume
```

Use `task perf:run` for quick local regression checks and
`task perf:run:prod-volume` before changing Explorer hot paths such as event
list queries, tag hydration, save/attendance enrichment, or cache behaviour.

### Other targets

| Command | Description |
|---------|-------------|
| `task perf:dev` | Run against an ad-hoc dev backend (`localhost:8001`). |
| `task perf:staging` | Run against remote staging (`https://api-develop.joinmovida.com`, 15 VUs × 5m). Staging is rate-limited unless `RATE_LIMIT_ENABLED=false` is set on the Fly app, so expect 429s in default profile. |
| `task perf:prod:smoke` | Read-only smoke against production (5 VUs × 2m). |
| `task perf:scenario:logs` | Tail the perf scenario backend logs. |
| `task perf:scenario:logs:prod-volume` | Tail the production-volume perf scenario backend logs. |
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

## Deployment

### Staging Local (docker-compose)

Validates the Docker images in a fully containerised stack before pushing to cloud.

```bash
task deploy:staging:local                    # build from develop branch
task deploy:staging:local:ref -- feature/x  # build from any git ref
task deploy:staging:local:cwd             # build from working directory (uncommitted, current CWD)

DRY_RUN=1 task deploy:staging:local        # preview without executing
```

Env files loaded: `secrets.env` + `.env.staging.local`

---

### Staging Remote (Fly + Neon + Cloudflare)

All remote staging deploys are **isolated from your working directory**: the
task creates a SHA-pinned worktree at `.worktrees/ref-<sha>` and runs every
deploy command from inside it. Your local checkout, uncommitted changes, and
current branch are never touched.

Gates:

- `REF` must be supplied and reachable from `origin/develop` (no feature branches)
- `git fetch origin develop` runs automatically before validation

**Full deploy (all three components in sequence):**

```bash
task deploy:staging:remote -- develop
# or any develop commit / SHA:
task deploy:staging:remote -- abc1234
```

No `git checkout` required — you can be on a feature branch with uncommitted
changes and the staging deploy still runs reproducibly from the requested ref.

**Deploy only one component:**

```bash
task deploy:staging:remote:db       -- develop  # alembic migrations → Neon develop branch
task deploy:staging:remote:backend  -- develop  # stage Fly secrets + fly deploy + smoke test
task deploy:staging:remote:frontend -- develop  # build frontend + wrangler pages deploy --branch=develop
```

Env files loaded: `secrets.env` + `secrets.staging.env` + `staging.remote.frontend.env` (always read
from your host repo, never from the worktree, since gitignored files are kept in host).

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

Same worktree-isolated model as staging — your local checkout is never touched.

**Components release independently.** Each component (`db`, `backend`, `frontend`) has its
own version counter and its own annotated tag of the form `<component>-vX.Y.Z` on `main`.

Gates (stricter than staging):

- `REF` must be an **annotated** tag: `<component>-vX.Y.Z` (or legacy bare `vX.Y.Z`)
- Tag's component prefix must match the deploy task (e.g. `backend-v1.2.0` for `deploy:prod:remote:backend`)
- Tag must be reachable from `origin/main`
- `git fetch origin main --tags` runs automatically before validation

**Deploy a single component:**

```bash
task deploy:prod:remote:db       -- db-v1.2.0        # alembic migrations → Neon main branch
task deploy:prod:remote:backend  -- backend-v1.2.0   # stage Fly secrets + fly deploy + smoke test
task deploy:prod:remote:frontend -- frontend-v1.2.0  # build frontend + wrangler pages deploy --branch=main
```

Env files loaded: `secrets.env` + `secrets.prod.env` + `.env.prod` (always
read from your host repo, never from the worktree).

URLs after deploy:
- Backend: <https://movida.fly.dev\>
- Frontend: <https://joinmovida.com\> (alias: <https://movida.pages.dev\>)

Verify:
```bash
task db:check:prod
task fly:logs
task fly:status
```

**Release flow (per-component):**

Each component releases on its own cadence. The release task tags `main` with
`<component>-vX.Y.Z` and then deploys it.

```bash
task git:release:prepare    # create develop → main PR
task git:release:ready      # mark ready for review
task git:release:merge      # merge develop → main

# Per-component release (tag + deploy):
task release:prod:backend  -- v1.2.0     # creates backend-v1.2.0, deploys backend
task release:prod:frontend -- v1.2.0     # creates frontend-v1.2.0, deploys frontend
task release:prod:db       -- v1.2.0     # creates db-v1.2.0, runs db migrations

# Interactive (suggests next patch from latest <comp>-v* tag, retype-confirm):
task release:prod:backend

# Aggregate (prompts y/N for each component in db → backend → frontend order):
task release:prod
```

**Inspecting releases vs deploys:**

```bash
task deploy:prod:status      # table: per-component released (latest tag) vs deployed (ref) vs drift
task deploy:staging:status   # same for staging (no release tags — drift vs origin/develop)
task deploy:prod:current        # one-line: current prod backend tag
```

Two distinct concepts:

- **Released** (`<comp>-vX.Y.Z` tag): immutable, append-only — what's been blessed for release.
- **Deployed** (`refs/deploys/prod/<comp>`): mutable pointer — what's actually running. Moves on every deploy, including rollbacks.

A gap between *released* and *deployed* means a tag exists that hasn't been pushed yet (or has been rolled back).
Each successful component deploy pushes the deployed SHA to its ref on `origin`,
so every developer sees the same authoritative view (no local state files,
no platform-specific introspection).

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
- `stop:scenario`, `stop:scenario:all`

---

## Common Workflows

End-to-end journeys from `git:feature` to a deployed release. Pick the one that
matches the shape of your change. Steps that are common to most journeys
(scenario QA, perf testing) are folded in where they normally happen, with
links back to their dedicated sections for the full reference.

### A. Feature or fix (full release — backend + frontend + DB)

The canonical end-to-end journey. Use this when your change touches more than
one component, or when you're unsure.

```bash
# 1. Branch off develop
git checkout develop && git pull
task git:feature -- my-feature              # or: task git:fix -- bug-123

# 2. Code locally
task start:dev                              # DB + backend + frontend, hot-reload
#    ...edit, commit as you go...

# 3. Fast tests + scenario QA
task test                                   # unit (backend + frontend)
task test:int:full                          # integration (isolated DB)
SCENARIO=share-im-going task start:scenario # reproduce specific data/state
#    → see Scenario Environment for the full list and authoring guide

# 4. Push + draft PR → develop
git add . && git commit -m "feat: …"
task git:pr                                 # push + open draft PR
task git:pr:checks                          # watch CI
task git:pr:ready                           # mark ready, get review, merge

# 5. Stage from develop
task deploy:staging:remote -- develop       # db + backend + frontend
task deploy:staging:status                  # confirm SHAs match develop
#    → manual QA on https://develop.joinmovida.com

# 6. (Optional) perf gate before promotion
task perf:staging                           # see Performance Testing

# 7. Promote develop → main
task git:release:prepare                    # opens develop → main PR
task git:release:ready
task git:release:merge

# 8. Tag + deploy per component
task release:prod                           # interactive: prompts y/N for db, backend, frontend
#    → enforces order: db → backend → frontend

# 9. Verify
task deploy:prod:status                     # released tag vs deployed SHA per component
```

Details: [Branching Strategy](#branching-strategy) · [Scenario Environment](#scenario-environment) · [Testing](#testing) · [Performance Testing](#performance-testing) · [Deployment](#deployment)

### B. Backend-only change

API/service code, no schema migration, no UI work.

```bash
task git:feature -- faster-search

task start:dev:backend
task test:unit:backend

# Scenario QA when the change affects observable behaviour
SCENARIO=event-suggestions task start:scenario

# Perf gate when touching hot paths (list endpoints, geocoding, dedup, etc.)
task perf:scenario:up                       # see Performance Testing
task perf:run
task perf:report
task perf:scenario:down

task git:pr && task git:pr:ready            # PR → develop, merge

task deploy:staging:remote:backend -- develop
task deploy:staging:status
# (optional) task perf:staging

task git:release:prepare && task git:release:merge
task release:prod:backend                   # interactive: suggests next patch from latest backend-v*
#    or explicit:  task release:prod:backend -- v1.4.0
task deploy:prod:status                     # db + frontend rows show no drift — expected
```

### C. Frontend-only change

UI/UX change, no API contract change.

```bash
task git:feature -- redesign-event-card

task start:dev:frontend
task test:unit:frontend

# Multi-user / share flows benefit from isolated browsers
SCENARIO=share-im-going task start:scenario BROWSER=isolated COUNT=2

task git:pr && task git:pr:ready

task deploy:staging:remote:frontend -- develop
task deploy:staging:status                  # manual QA on https://develop.joinmovida.com

task git:release:prepare && task git:release:merge
task release:prod:frontend
task deploy:prod:status
```

### D. DB migration

New alembic revision. Usually paired with a backend release in the same cycle.

```bash
task git:feature -- add-event-rating-column

# Author + apply locally
task db:migrate:dev
task db:check:dev

# Validate against scenario data so you catch backfill issues
SCENARIO=event-rating task db:reset:scenario
SCENARIO=event-rating task start:scenario

task git:pr && task git:pr:ready

task deploy:staging:remote:db -- develop
task db:check:staging:remote

task git:release:prepare && task git:release:merge
task release:prod:db                        # → then release:prod:backend if backend code depends on it
task db:check:prod
```

⚠️ When migrations and backend code ship together: **`db` first, then `backend`** — the new schema must be in place before the new code runs. `task release:prod` enforces this order automatically.

### E. Hotfix on prod (urgent)

Bug in production, must ship without waiting for develop.

```bash
task git:hotfix -- nullpointer-on-share     # branches from main
#    ...fix + commit...

task test
task git:pr                                 # PR → main
task git:pr:ready                           # review, merge

task release:prod:backend                   # (or :frontend / :db) — patch bump
task deploy:prod:status

# Back-merge so develop has the fix
git checkout develop && git pull
git merge --no-ff origin/main && git push
```

### F. Rollback

Re-deploy a previous tag. The deploy ref moves backward; release-tag history is untouched.

```bash
task deploy:prod:status                              # find the previous tag
task deploy:prod:remote:backend -- backend-v1.3.0    # roll backend back
task deploy:prod:status                              # backend now points at v1.3.0
```

### G. Local-stack validation (no remote)

Validate the Docker images end-to-end before touching staging — useful when
debugging container-only issues (entrypoints, env wiring, build args).

```bash
task deploy:staging:local                   # build from develop + docker-compose up
task deploy:staging:local:cwd               # build from working directory (uncommitted)
task stop:staging                           # tear down
```

### H. Infra-only redeploy (fly.toml, Dockerfile, env)

When the change is **not** in source code — tweaking Fly memory/cpu/scaling,
adjusting the Dockerfile, fixing env wiring — there's nothing worth tagging.
Use the CWD path: it deploys the working directory as-is, with no git
checkout, no tag bump, and no change to release history.

```bash
# Test on staging first
task deploy:staging:remote:cwd:backend      # deploy CWD (uncommitted) to staging Fly app
task deploy:staging:status                  # confirm

# Apply to prod
task deploy:prod:remote:cwd:backend         # deploy CWD (uncommitted) to prod Fly app
# (or :db / :frontend for those components)
```

⚠️ Skips the release flow entirely — no `<comp>-vX.Y.Z` tag is created and
`refs/deploys/prod/<comp>` still points at the last tagged release. Commit the
infra change to `develop` afterwards so the next real release picks it up.

---

## Task Commands Reference

### Development

| Command | Description |
|---------|-------------|
| `task start:dev` | DB + backend (reload) + frontend |
| `task start:dev BROWSER=isolated` | Same, opens one isolated Chrome session |
| `task start:dev BROWSER=isolated COUNT=N` | Same, opens N isolated Chrome sessions |
| `task start:dev BROWSER=isolated RESET_BROWSER=1` | Same, but wipe profile dirs first |
| `task start:dev:debug` | Same + debugpy on port 5678 |
| `task start:dev:mock` | Same with mock calendar (no Google creds) |
| `task start:dev:db` | Dev database only |
| `task start:dev:backend` | Backend only |
| `task start:dev:frontend` | Frontend only |
| `task stop:dev` | Stop all dev services |
| `task stop:dev:volumes` | Stop dev + destroy DB data ⚠️ |

### Deploy — Staging Remote (atomic)

All require `REF` (a develop commit). Runs from an isolated `.worktrees/ref-<sha>` — your working tree is not touched.

| Command | Description |
|---------|-------------|
| `task deploy:staging:remote:db -- <ref>` | Alembic migrations → Neon develop |
| `task deploy:staging:remote:backend -- <ref>` | Stage secrets + fly deploy + smoke test |
| `task deploy:staging:remote:frontend -- <ref>` | Build + wrangler pages deploy --branch=develop |
| `task deploy:staging:remote -- <ref>` | All three in sequence |

### Deploy — Prod Remote (atomic)

All require `REF` (an annotated tag `vX.Y.Z` on main). Runs from an isolated `.worktrees/ref-<sha>` — your working tree is not touched.

| Command | Description |
|---------|-------------|
| `task deploy:prod:remote:db -- <tag>` | Alembic migrations → Neon main |
| `task deploy:prod:remote:backend -- <tag>` | Stage secrets + fly deploy + smoke test |
| `task deploy:prod:remote:frontend -- <tag>` | Build + wrangler pages deploy --branch=main |
| `task deploy:prod:remote -- <tag>` | All three in sequence (prompts with current → next + diff) |

Each `prod:remote*` task prompts with the **current deployed tag → next tag** and the
commit diff before proceeding. The deploy uses an isolated worktree so your working tree
is never touched.

### Deploy — CWD variants (no git checks)

For CI runners (which already check out the SHA they want to deploy), thin variants skip
all git validation, worktree provisioning, and prompts. They run `fly deploy` / `wrangler
pages deploy` / `alembic upgrade head` directly from the current working directory.

| Command | Description |
|---------|-------------|
| `task deploy:staging:remote:cwd` | Full staging deploy from CWD |
| `task deploy:staging:remote:cwd:db\|backend\|frontend` | Single staging component from CWD |
| `task deploy:prod:remote:cwd` | Full prod deploy from CWD |
| `task deploy:prod:remote:cwd:db\|backend\|frontend` | Single prod component from CWD |

Set `HOST_DIR=<path>` if secrets/credentials live outside the CI checkout, and
`ALEMBIC=alembic` if alembic is on `$PATH` rather than at `$HOST_DIR/.venv/bin/alembic`.

### Deploy — Staging Local (docker-compose)

| Command | Description |
|---------|-------------|
| `task deploy:staging:local` | Build from develop + docker-compose up |
| `task deploy:staging:local:ref -- <ref>` | Build from git ref + docker-compose up |
| `task deploy:staging:local:cwd` | Build from working directory + docker-compose up |
| `task start:staging:local BROWSER=isolated` | Same, opens one isolated Chrome session |
| `task start:staging:local BROWSER=isolated COUNT=N` | Same, opens N isolated Chrome sessions |
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
| `task start:scenario BROWSER=isolated` | Same, opens one isolated Chrome session |
| `task start:scenario BROWSER=isolated COUNT=N` | Same, opens N isolated Chrome sessions |
| `task start:scenario BROWSER=isolated RESET_BROWSER=1` | Same, but wipe profile dirs first |
| `task start:scenario:ref -- <ref>` | All-Docker from git ref |
| `task stop:scenario` | Stop one scenario (also closes its isolated Chrome sessions) |
| `task stop:scenario KEEP_BROWSER=1` | Same, but leave isolated Chrome sessions open |
| `task stop:scenario:all` | Stop all running scenarios (closes their isolated Chrome sessions) |
| `task stop:scenario:all KEEP_BROWSER=1` | Same, but leave isolated Chrome sessions open |
| `task db:seed:scenario` | Seed scenario DB |
| `task db:reset:scenario` | Reset scenario DB ⚠️ |
| `task logs:scenario` | Tail scenario logs |

All scenario commands accept `SCENARIO=<name>`.

### Browser

Three orthogonal parameters control browser behaviour on `start:*` tasks:

- `BROWSER=none|shared|isolated` (default `none` for `start:*`, default `shared` for `start:open:umami`)
  - `none`     servers only, no browser opened
  - `shared`   focus an existing Chrome tab matching the URL, else open one tab in your default Chrome profile (cookies + localStorage shared with all your normal browsing)
  - `isolated` open `COUNT` Chrome sessions, each with its own `--user-data-dir` (independent cookies + localStorage). Idempotent: re-running focuses the existing window.
- `COUNT=N` (only consulted with `BROWSER=isolated`, default `1`)
- `RESET_BROWSER=1` (only consulted with `BROWSER=isolated`; wipes the matching profile dirs first for a true clean start)

Isolated profile dirs live under `/tmp/chrome-profiles/<label>-<i>` and are stable per (env, scenario, index) — re-running the same task focuses the existing window instead of duplicating it. Pass `RESET_BROWSER=1` to delete the dir before launching.

| Command | Description |
|---------|-------------|
| `task open:shared:dev` | Focus or open one tab on dev in your default Chrome |
| `task open:shared:scenario SCENARIO=<name>` | Same, on a scenario |
| `task open:shared:staging:local` | Same, on local staging |
| `task open:shared:staging:remote` | Same, on remote staging |
| `task open:shared:prod` | Same, on production |
| `task open:isolated:dev [COUNT=N] [RESET_BROWSER=1]` | Open N isolated Chrome sessions on dev |
| `task open:isolated:scenario SCENARIO=<name> [COUNT=N] [RESET_BROWSER=1]` | Same, on a scenario |
| `task open:isolated:staging:local [COUNT=N] [RESET_BROWSER=1]` | Same, on local staging |
| `task open:isolated:staging:remote [COUNT=N] [RESET_BROWSER=1]` | Same, on remote staging |
| `task open:isolated:prod [COUNT=N] [RESET_BROWSER=1]` | Same, on production |
| `task open:clean` | Remove ALL isolated Chrome profile dirs |
| `task open:clean:dev` | Remove only `dev-*` isolated profile dirs (keep scenarios) |

Scenario stop tasks (`stop:scenario`, `stop:scenario:all`) close their isolated Chrome sessions and remove the matching profile dirs by default. Pass `KEEP_BROWSER=1` to leave them open.

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
| `task release:prod -- v1.0.0` | Tag main + remote prod deploy (combined) |
| `task release:prod` | Interactive: suggest next patch (BUMP=minor/major to override) |
| `task deploy:prod:status\|staging` | Show what's currently deployed per component |
| `task deploy:prod:current` | Print the currently deployed prod backend tag |

### Build

| Command | Description |
|---------|-------------|
| `task build:staging` | Build images from develop |
| `task build:prod -- v1.0.0` | Build from main |
| `task build:ref -- <ref>` | Build from any git ref |
| `task build:cwd` | Build from working directory |
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
| `task perf:scenario:up:prod-volume` | Start the production-volume perf scenario (1,500 generated events + engagement rows) |
| `task perf:scenario:down` | Stop perf scenario, drop DB |
| `task perf:scenario:logs` | Tail perf scenario logs |
| `task perf:run` | Run k6 against the running perf scenario (auto-port) |
| `task perf:run:prod-volume` | Run k6 against the running production-volume perf scenario (auto-port) |
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
- `staging:remote` tasks → `secrets.staging.env` (Neon develop branch)
- `prod:remote` tasks → `secrets.prod.env` (Neon main branch)

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
