# Repository rules for AI assistants

Scope-specific rules live in [.github/instructions/backend.instructions.md](.github/instructions/backend.instructions.md) and [.github/instructions/frontend.instructions.md](.github/instructions/frontend.instructions.md). The rules below apply everywhere.

## Don't
- Don't commit `.env*` files (except `*.env.example`), credentials, generated build output, or large binaries.
- Don't reformat or "clean up" unrelated lines — keep diffs minimal and reviewable.
- Don't add features, abstractions, or refactors that weren't requested.
- Don't run destructive commands (DB drops, `rm -rf`, `git push --force`, `git reset --hard`, branch/tag deletion) without explicit user confirmation.
- Don't bypass safety checks (`--no-verify`, skipping CI, force-merging).

## Do
- When unsure between two reasonable approaches, follow the pattern already used in a neighboring file.
- Match existing code style; don't introduce a new formatter or linter config.
- Prefer editing an existing file over creating a new one.
- Read a file before modifying it; understand the surrounding code first.

## Workflow
- Dev setup, ports, and task commands are in [docs/DEVELOPMENT_WORKFLOW.md](docs/DEVELOPMENT_WORKFLOW.md) and the [Taskfile.yml](Taskfile.yml).
- Use `task` targets rather than ad-hoc shell commands when one exists.
