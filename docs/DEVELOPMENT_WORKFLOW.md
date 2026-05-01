# Development Workflow

This document describes the CI/CD workflow for the Movida project.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Environment Overview](#environment-overview)
- [Daily Development Workflow](#daily-development-workflow)
- [Branching Strategy](#branching-strategy)
- [Deployment](#deployment)
- [Scenario Environment](#scenario-environment)
- [Testing](#testing)
- [Safety Features](#safety-features)
- [Task Commands Reference](#task-commands-reference)

---

## Prerequisites

Install these tools before starting:

```bash
# macOS
brew install go-task/tap/go-task  # Taskfile runner
brew install gh                    # GitHub CLI
brew install act                   # Local CI runner (optional)

# Verify installations
task --version
gh --version
docker --version
```

## Quick Start

```bash
# 1. Clone the repository
git clone <repository-url>
cd salsa-events-calendar

# 2. Install dependencies
task install

# 3. Start development environment
task start:dev:debug

# 4. Open in browser
# Frontend: http://localhost:5173
# Backend:  http://localhost:8001/docs
```

---

## Environment Overview

| Environment | Purpose | Database Port | Backend Port | Frontend Port |
|-------------|---------|---------------|--------------|---------------|
| **Dev** | Local development with VSCode debugging | 5434 | 8001 | 5173 |
| **Staging** | Containerized integration environment | 5436 | 8002 | 3001 |
| **Scenario** | Isolated manual testing with scenario data | 5437+ | 8003+ | 3002+ |
| **Prod** | Production (local or cloud) | 5438 | 8080 | 3000 |

> **Scenario ports** are per-instance. The default instance uses 5437/8003/3002. Each named scenario gets a deterministic offset (hash-based). See [Scenario Port Allocation](#scenario-port-allocation) for details.

### Dev Environment

- **Database**: Docker container (PostgreSQL 16)
- **Backend**: Local Python process (debuggable via debugpy)
- **Frontend**: Vite dev server (hot reload)

### Staging Environment

- Fully containerized (Docker Compose)
- Built from `develop` branch
- Uses `:develop` tagged images

### Scenario Environment

- Isolated full stack for manual scenario testing
- Default mode: local code + Docker DB + live reload (like dev)
- Optional `:ref` mode: all-Docker from any git ref, tag, or branch
- Supports scenario data overlays (custom YAML seed folders)
- **Multi-instance**: run multiple scenarios simultaneously with `SCENARIO=<name>`

### Prod Environment

- Fully containerized (Docker Compose)
- Built from `main` branch with semantic version tags
- Uses versioned images (e.g., `:v1.2.0`)

---

## Daily Development Workflow

### 1. Start Your Day

```bash
# Update develop branch
git checkout develop
git pull origin develop

# Create feature branch
task git:feature -- my-feature-name
```

### 2. Start Development Environment

```bash
# Start database + backend (with debugger) + frontend
task start:dev:debug
```

Services running:

- Frontend: <http://localhost:5173>
- Backend API: <http://localhost:8001>
- Swagger Docs: <http://localhost:8001/docs>
- Debugger: Port 5678 (attach from VSCode)

### 3. Attach VSCode Debugger

1. Press `F5` in VSCode
2. Select **"Backend: Attach"** or **"Full Stack Debug"**
3. Set breakpoints and debug!

### 4. Run Tests

```bash
# Quick unit tests
task test

# Backend only
task test:unit:backend

# Frontend type check
task test:unit:frontend
```

### 5. Commit and Create PR

```bash
# Commit your changes
git add .
git commit -m "feat: add my feature"

# Push and create draft PR (auto-detects target: develop or main for hotfix/*)
task git:pr
```

### 6. End of Day

```bash
# Stop services
task stop:dev
```

---

## Branching Strategy

```
main (production)
├── hotfix/critical-bug     → Direct PR to main
│
develop (integration)
├── feature/new-feature     → PR to develop
├── fix/bug-fix             → PR to develop
```

### Branch Types

| Type | Base | Purpose | Command |
|------|------|---------|---------|
| `feature/*` | develop | New features | `task git:feature -- <name>` |
| `fix/*` | develop | Bug fixes | `task git:fix -- <name>` |
| `hotfix/*` | main | Critical prod fixes | `task git:hotfix -- <name>` |

### Pull Request Flow

```bash
# Create feature branch
task git:feature -- my-feature

# ... make changes ...

# Create draft PR (auto-detects target)
task git:pr

# When ready for review
task git:pr:ready

# View PR status
task git:pr:checks

# After approval, merge (shows next steps)
task git:pr:merge
```

---

## Deployment

### Deploy to Staging

```bash
# Build and deploy to staging
task deploy:staging

# Preview without executing
DRY_RUN=1 task deploy:staging
```

This will:

1. Build Docker images from develop (via git worktree)
2. Tag images as `:develop`
3. Start the staging stack on ports 8002/3001

Access: <http://localhost:3001>

You can also deploy from any git ref or your working directory:

```bash
# Deploy from a specific branch/tag
task deploy:staging:ref -- feature/my-branch

# Deploy from uncommitted working directory
task deploy:staging:dirty
```

### Deploy to Production

```bash
# 1. Create release PR (develop → main)
task git:release:prepare

# 2. Mark it ready for review
task git:release:ready

# 3. Merge the release PR
task git:release:merge

# 4. Tag the release on main
task git:release:tag -- v1.2.0

# 5. Deploy the tagged version
task deploy:prod -- v1.2.0
```

Or use the combo command:

```bash
task release -- v1.2.0
```

Access: <http://localhost:3000>

---

## Scenario Environment

The scenario environment lets you spin up an isolated full stack, seed it with scenario-specific test data, and manually verify features.

### Scenario Folders

```
scenarios/<name>/
├── config.yaml           # Required: calendar_service (google|mock)
├── calendars.yaml        # Optional: calendar settings
├── mock-sync-events.yaml # Optional: events served by MockCalendarService during sync
├── db-events.yaml        # Optional: events pre-seeded directly into DB (before sync fires)
└── secrets.env           # Optional: per-scenario secret overrides (gitignored)
```

### Default Mode (Local Code + Live Reload)

```bash
# Default instance (ports 5437/8003/3002)
task start:scenario

# Named scenario — gets its own DB, ports, and containers
task start:scenario SCENARIO=my-test

# Run a second scenario simultaneously
task start:scenario SCENARIO=another-test
```

### Docker Mode (From Git Ref)

```bash
# From a branch
task start:scenario:ref -- feature/new-feature

# From a branch with a named scenario
task start:scenario:ref -- feature/new-feature SCENARIO=my-test
```

### Lifecycle

```bash
# Tail logs
task logs:scenario SCENARIO=my-test

# Re-seed
task db:seed:scenario SCENARIO=my-test

# Full reset
task db:reset:scenario SCENARIO=my-test

# Stop one instance
task stop:scenario SCENARIO=my-test

# Stop ALL instances
task stop:scenario:all
```

### Scenario Port Allocation

Each scenario gets a **deterministic port offset** from a hash of its name, added to the base ports (DB=5437, API=8003, WEB=3002).

Run `task scenarios` to see all current assignments.

---

## Testing

### Unit Tests

```bash
task test               # All unit tests
task test:unit:backend  # Backend only
task test:unit:frontend # Frontend type check + build
```

### Integration Tests

```bash
# Setup integration DB (one-time)
task db:setup:integ

# Run integration tests
task test:int

# Full cycle (setup → test)
task test:int:full
```

### All Tests

```bash
task test:all           # unit → integration
```

### CI Simulation

```bash
task test:ci            # Simulate CI locally via Act
```

---

## Safety Features

### DRY_RUN=1

All destructive operations support `DRY_RUN=1`:

```bash
DRY_RUN=1 task db:reset:dev
DRY_RUN=1 task deploy:staging
DRY_RUN=1 task deploy:prod -- v1.0.0
DRY_RUN=1 task stop:dev:volumes
```

### Confirmation Prompts

Destructive tasks require interactive confirmation:

- All `db:reset:*` tasks
- All `stop:*:volumes` tasks
- `deploy:prod`
- `stop:scenario` and `stop:scenario:all`

---

## Task Commands Reference

### Branching (git:*)

| Command | Description |
|---------|-------------|
| `task git:feature -- <name>` | Create feature branch from develop |
| `task git:fix -- <name>` | Create fix branch from develop |
| `task git:hotfix -- <name>` | Create hotfix branch from main |

### Pull Requests (git:pr:*)

| Command | Description |
|---------|-------------|
| `task git:pr` | Push and create draft PR (auto-detects target) |
| `task git:pr:publish` | Push and create ready PR |
| `task git:pr:ready` | Mark draft as ready for review |
| `task git:pr:checks` | Show CI status |
| `task git:pr:merge` | Squash and merge (shows next steps) |
| `task git:pr:view` | Open PR in browser |

### Release (git:release:*)

| Command | Description |
|---------|-------------|
| `task git:release:prepare` | Create release PR (develop → main) |
| `task git:release:ready` | Mark release PR as ready |
| `task git:release:merge` | Merge release PR (shows next steps) |
| `task git:release:tag -- v1.0.0` | Tag release on main |
| `task git:tags` | List all release tags |
| `task release -- v1.0.0` | Combo: tag + deploy to prod |

### Development

| Command | Description |
|---------|-------------|
| `task start:dev` | Start full dev environment (DB + backend + frontend) |
| `task start:dev:debug` | Start full stack with debugging (port 5678) |
| `task start:dev:mock` | Start with mock calendar (no Google creds) |
| `task start:dev:db` | Start dev database only |
| `task start:dev:backend` | Start backend only |
| `task start:dev:backend:debug` | Start backend with debugger |
| `task start:dev:frontend` | Start frontend only |
| `task stop:dev` | Stop all dev services |

### Staging

| Command | Description |
|---------|-------------|
| `task deploy:staging` | Build from develop + deploy |
| `task deploy:staging:ref -- <ref>` | Build from git ref + deploy |
| `task deploy:staging:dirty` | Build from working directory + deploy |
| `task start:staging` | Start staging (existing images) |
| `task stop:staging` | Stop staging stack |

### Scenario

| Command | Description |
|---------|-------------|
| `task start:scenario` | Local code + Docker DB + live reload |
| `task start:scenario:ref -- <ref>` | Build from git ref + deploy all-Docker |
| `task stop:scenario` | Stop one scenario instance |
| `task stop:scenario:all` | Stop ALL running scenario instances |
| `task db:seed:scenario` | Seed scenario database |
| `task db:reset:scenario` | Reset scenario database |
| `task logs:scenario` | Tail scenario logs |

All scenario commands accept `SCENARIO=<name>` to target a specific instance.

### Production

| Command | Description |
|---------|-------------|
| `task deploy:prod -- v1.2.0` | Deploy to local prod |
| `task start:prod` | Start prod (existing images) |
| `task stop:prod` | Stop prod stack |

### Database

| Command | Description |
|---------|-------------|
| `task db:migrate` | Run migrations (dev) |
| `task db:migrate:staging` | Run migrations on staging |
| `task db:migrate:prod` | Run migrations on prod |
| `task db:seed` | Seed dev database |
| `task db:seed:staging` | Seed staging database |
| `task db:reset:dev` | ⚠️ Reset dev database (`DRY_RUN=1` to preview) |
| `task db:reset:staging` | ⚠️ Reset staging database |
| `task db:reset:prod` | 🚨 Reset prod database |
| `task db:status:dev` | Show migration status |
| `task db:check:dev` | Validate migration health |

### Build

| Command | Description |
|---------|-------------|
| `task build:staging` | Build images from develop |
| `task build:prod -- v1.0.0` | Build images from main |
| `task build:ref -- <ref>` | Build from any git ref |
| `task build:dirty` | Build from working directory |
| `task build:list` | List all Docker images |
| `task build:clean` | Remove old/dangling images |
| `task build:clean:all` | ⚠️ Remove ALL images |

### Testing

| Command | Description |
|---------|-------------|
| `task test` | Quick unit tests |
| `task test:unit` | Full unit test suite (backend + frontend) |
| `task test:unit:backend` | Backend unit + API tests |
| `task test:unit:frontend` | Frontend type check + build |
| `task test:int` | Integration tests |
| `task test:int:full` | Full cycle (setup → test) |
| `task test:all` | All tests (unit + integration) |
| `task test:ci` | Simulate CI locally via Act |

### Utilities

| Command | Description |
|---------|-------------|
| `task install` | Install all dependencies |
| `task status` | Show running containers |
| `task scenarios` | List scenario instances + ports |
| `task help` | Show quick reference |

---

## Port Reference

| Service | Dev | Test | Staging | Scenario (default) | Prod |
|---------|-----|------|---------|---------------------|------|
| PostgreSQL | 5434 | 5435 | 5436 | 5437 | 5438 |
| Backend | 8001 | — | 8002 | 8003 | 8080 |
| Frontend | 5173 | — | 3001 | 3002 | 3000 |
| Debugger | 5678 | — | — | — | — |

---

## Troubleshooting

### Database connection failed

```bash
# Check if dev database is running
docker ps | grep calendar_db_dev

# Start it
task start:dev:db
```

### Port already in use

```bash
# Find what's using the port
lsof -i :8001

# Kill the process
kill -9 <PID>
```

### Docker images not found

```bash
# List available images
task build:list

# Build them
task build:staging       # For staging (from develop)
task build:prod -- v1.0.0  # For prod (from main)
```

### Reset everything

```bash
# Stop all services
task stop:dev
task stop:staging
task stop:prod

# Remove data (⚠️ destructive — prompts for confirmation)
task stop:dev:volumes
task stop:staging:volumes

# Preview first with DRY_RUN
DRY_RUN=1 task stop:dev:volumes
```
