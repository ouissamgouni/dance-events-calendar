---
applyTo: "frontend/**"
---

# Frontend rules

Reference: [frontend/src/pages/MyCalendar.tsx](frontend/src/pages/MyCalendar.tsx), [frontend/src/components/SignInNudge.tsx](frontend/src/components/SignInNudge.tsx).

## Don't
- Don't use `window.alert`, `window.confirm`, `window.prompt`, or rely on `console.*` for user-facing feedback (console is for developer debugging only — leaving existing logs is fine).
- Don't hardcode raw hex or off-palette Tailwind colours for chrome/text/surfaces — use the semantic design tokens below.
- Don't use red/rose for positive confirmations (RSVP success, saved, sign-in nudges).
- Don't introduce new top-level dependencies, UI libraries, or icon sets without asking.
- Don't add raw `fetch`/`axios` in components — use the existing client in [frontend/src/api.ts](frontend/src/api.ts).
- Don't use `any` or `@ts-ignore` without a one-line reason comment.
- Don't reformat unrelated lines or do drive-by refactors.

## Design tokens (Light theme)
Semantic Tailwind v4 tokens live in [frontend/src/index.css](frontend/src/index.css) (`@theme`). Prefer these over raw palette steps:
- Brand (Movida): `brand` (`#A22E43`) — logo wordmark, profile/passport hero headers.
- Action / selected / link: `action` (`#2563EB`) — primary CTAs, active nav, links.
- Text: `text-ink` (`#172033` main), `text-ink-soft` (`#667085` secondary), `text-muted` (`#98A2B3`).
- Surfaces: `bg-canvas` (`#F7F9FC` app background), `bg-surface` (`#FFFFFF` cards).
- Borders: `border-line` (`#E4E7EC`), `border-card-line` (`#EAECF0` subtle card border).
- Success/going: `success` (`#079455`). Error/destructive: `danger` (`#D92D20`).

## Shape
- **Rounded cards.** Cards/surfaces use `rounded-card` (~14px). Small controls (buttons, pills, inputs, chips) stay square unless a neighbouring pattern rounds them.
- Allowed circular shapes: avatars (`rounded-full`), small status dots, genuinely circular icon toggles.

## Layout & spacing
- 4px grid: `4 / 8 / 12 / 16 / 24 / 32 / 48`. Screen gutters 16px, section gap 24px, card padding 16px, card-to-card gap 12px, icon/text gap 8px.
- **Reduce borders.** Prefer whitespace over enclosing every section in a rectangle. Cards sit on `bg-canvas`; use `border-card-line` only where a card genuinely needs separation. Avoid nested bordered rectangles.

## Typography
- Screen title 24/700, section title 18/600–700, event title 16–18/600, body 14–16/400, metadata 14/400, caption/tag 12/500, bottom-nav label 12/500–600. Prefer typography over borders/colour for hierarchy.

## Color
- **Primary** (Sign in, Save, Submit, Share, primary CTAs): `bg-action text-white hover:opacity-90`.
- **Secondary**: `border border-line bg-surface text-ink hover:bg-canvas`.
- **Active filter / selected pill**: `bg-action border-action text-white`.
- **Red is reserved**:
  - Destructive actions (delete account, irreversible removals): `bg-danger` / `text-danger`.
  - True error states / failed jobs: `bg-danger` (status indicator, not a button).
- Inside a JSX block you're already editing, migrate nearby `slate-*`/`gray-*`/`rose-*` neutrals and CTAs to the tokens above. Don't sweep unrelated files.

## Feedback & forms
- Confirmations: in-app inline UI (toast, inline banner, button state change). Toast/banner styling: neutral (`bg-slate-50 border-slate-200`) or blue (`bg-blue-50 border-blue-100`).
- Loading/disabled states must be visible (spinner or `disabled:opacity-50 cursor-not-allowed`).
- Forms: disable submit while in-flight; show field-level errors inline (not as a toast).

## Accessibility (basics, not exhaustive)
- Buttons need discernible text or `aria-label`. Inputs need labels. Color is not the only signal.

## Tests (minimal but real)
- Add/update **only major or critical** tests for behavior changes — not for pure styling/copy tweaks.
- A **new branch in business logic** (e.g. a new prop-driven visibility/permission rule, a new pure helper in `src/utils/`) needs a test; a new component's key interaction (render + one user action) needs a test.
- Prefer updating an existing test file over creating a new one; for a new pure helper with no existing test file, add a co-located `*.test.ts`/`*.test.tsx` (see `src/utils/sectionVisibility.test.ts` for the pattern).
- After any behavior change, run `task test:unit:frontend` (type-check + vitest + build) before reporting done.
