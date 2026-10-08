# HHereditas — progress & next steps (handoff)

Live progress: every agent keeps a log in `docs/progress/<stage>-<module>.md` (goal, done, current
state, open problems, next steps). Read those first when resuming after an interruption.

## Where things are written down
- `docs/progress/specs/` — specs: `_common-core.md`, `_common-ui.md` (shared rules), `core-*.md`,
  `ui-*.md`, `app-integration.md` (the next stage).
- `docs/progress/findings/` — adversarial review findings and implementer/fix reports per module.
- `docs/progress/api/` — API summaries written by the final verifiers (inputs for integration).

## Status (in progress)
- Core engine (`packages/core`): all 7 modules implemented and reviewed; workflow
  `core-engine-finish` is completing the review fixes, verifying each module, then building the
  cloning module (implement → 2 reviews → fix → verify).
- UI (`packages/ui`, `packages/viewer`, `apps/desktop/src/shell`): workflow `ui-components-finish`
  is finishing the design system + shell, circular and linear maps, then design/interaction review,
  fixes and verification for all five components (sequence view and gel are already built).
- Desktop shell (`apps/desktop/src-tauri`): compiles (`cargo build`) and runs under WSLg; file
  associations, single instance, window state, file permissions done.

## Next
1. Integration per `docs/progress/specs/app-integration.md` (store, file open/save, wiring, panels,
   digest/gel, primers, cloning wizards, export, settings), then E2E tests and a visual review.
2. `npm run tauri dev -w @hhereditas/desktop` smoke test of the full app.

## Resuming after an interruption
1. `git status` / `git log` — commits mark completed stages.
2. Read `docs/progress/*.md` logs of the stage that was running.
3. Re-run that stage only (scripts are in the session's workflow folder; copies in the scratchpad).
