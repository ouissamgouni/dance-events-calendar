# Movida — Salsa & Dance Events Calendar

Movida is a production web app that aggregates, enriches, and socially curates
salsa & dance events into a single map- and calendar-first experience. It pulls
events from multiple sources (including public Google Calendars), deduplicates
and geocodes them, and layers a lightweight social graph on top so people can
see which events their friends are attending.

> **Live:** [joinmovida.com](https://joinmovida.com)

> **License / usage:** This repository is **source-available for review only**.
> All rights reserved — see [LICENSE](LICENSE). You may read the code; you may
> not copy, deploy, or use it. If you're a recruiter or engineer evaluating the
> work, welcome — read on.

---

## Why it exists

Dance-scene events are scattered across Instagram pages, WhatsApp groups, venue
sites, and personal Google Calendars. Movida consolidates them into one place,
adds structured data (location, price, tags), and makes discovery social.

## Feature highlights

- **Map + calendar discovery** — FullCalendar views plus a clustered Leaflet map.
- **Automated ingestion pipeline** — sync from external sources, deduplicate,
  geocode, extract price, suggest tags.
- **Social layer** — follows, friends, friends-of-friends suggestions,
  "I'm going", and friend-aware event feeds.
- **Personalized notifications** — email, web push, and in-app, driven by
  interest profiles, reminders, and activity digests.
- **Admin curation** — moderation, curation pipeline, organizer claims.
- **Privacy-first** — GDPR consent, data-export, and account-deletion flows.

## Architecture

```
┌────────────────────┐        ┌──────────────────────────────┐
│  Frontend (React)  │  HTTP  │        Backend (FastAPI)       │
│  Vite · TypeScript │ <────> │  SQLModel · Alembic · Postgres │
│  FullCalendar      │        │  Ingestion & enrichment worker │
│  Leaflet + cluster │        │  Notification delivery         │
└────────────────────┘        └──────────────────────────────┘
        │                                    │
   Cloudflare Pages                     Fly.io + Neon Postgres
```

### Frontend
- **React 19 + TypeScript + Vite**
- **FullCalendar** (day grid, time grid, list views)
- **Leaflet** with marker clustering for the map
- **React Router**, GDPR cookie consent
- Testing: **Vitest** + Testing Library (unit), **Playwright** (e2e), **MSW** (mocks)

### Backend
- **FastAPI** + **SQLModel** over **PostgreSQL**, migrations via **Alembic**
- Google Calendar ingestion (`google-api-python-client`, OAuth via `authlib`)
- Geocoding (`geopy`), web push (`pywebpush`), rate limiting (`slowapi`)
- Modular services: ingestion pipeline, dedup, geocoding, follows/social graph,
  interest-based notification matching, reminders, popularity, admin curation
- Testing: **pytest** (+ `pytest-asyncio`)

### Infrastructure
- **Frontend:** Cloudflare Pages (+ Workers/Functions)
- **Backend:** Fly.io
- **Database:** Neon (managed Postgres)
- **Tooling:** Taskfile task runner, Docker, GitHub Actions CI, pre-commit hooks

## Repository layout

```
backend/     FastAPI app, services, DB models, Alembic migrations, tests
frontend/    React + Vite SPA (components, pages, hooks, context, tests)
config/      Per-environment config (secrets are git-ignored, never committed)
docs/        Development workflow and phase design docs
infra/       Docker and infrastructure definitions
perf/        k6 performance test suites
scenarios/   Isolated, seeded QA scenarios
scripts/     Operational and maintenance scripts
```

## Engineering notes

- **Multi-environment workflow** (dev / staging-local / staging-remote /
  production / scenario), each with isolated config and ports — see
  [docs/DEVELOPMENT_WORKFLOW.md](docs/DEVELOPMENT_WORKFLOW.md).
- **Scenario-driven QA:** reproducible, seeded environments under `scenarios/`
  for manually verifying complex flows in isolation.
- **Performance testing:** k6 suites under `perf/`.
- **CI/CD:** GitHub Actions with pre-commit enforcement.

## Running locally

Full setup, ports, and task commands are documented in
[docs/DEVELOPMENT_WORKFLOW.md](docs/DEVELOPMENT_WORKFLOW.md) and the
[Taskfile.yml](Taskfile.yml). In short:

```bash
task install     # Python venv + npm deps
task start:dev   # DB + backend (--reload) + frontend (Vite)
```

- Frontend: <http://localhost:5173>
- Backend API docs: <http://localhost:8001/docs>

> Secrets (`config/secrets.*.env`, service-account keys, source lists) are
> git-ignored and **not** part of this repository. The app will not fully run
> without them.

## License

Copyright © 2026 Ouissam Gouni. All rights reserved.

This source is published for review and evaluation only. It is **not**
open-source and grants no rights to use, copy, modify, or distribute the code.
See [LICENSE](LICENSE) for the full terms.
