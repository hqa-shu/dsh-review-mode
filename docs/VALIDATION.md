# Validation of the 2.1.0 development snapshot

Date: **2026-10-04**. Tested on macOS with DeepSeek Harness Desktop `0.2.0-rc.2` and Node.js 24. This is a development snapshot, not a stable release.

The current portable product-contract suite runs with `npm test` (or `node scripts/run-tests.mjs`): **20 scripts, 269 assertions passed**. It creates an isolated temporary home for each script and uses synthetic records. The host-backed suite runs with `npm run test:host` in the configured development environment: **2 scripts, 37 assertions passed**. Those tests validate the actual Harness SDK command-log transport and reviewer tool isolation. Source syntax and public-package checks run with `npm run check`.

The installed plugin was changed, the desktop app was fully quit and relaunched, and a synthetic Python-study conversation was operated through the real UI for ten user-experience cycles and five extra regression rounds. Observed behaviors include immediate selected-target review, short expandable insights, evidence questions, cancellation, pause/resume, restored target after restart, new-message monitoring, an independent main-chat reply, and a new-result notice that opens the latest card. [The iteration record](../ITERATIONS.md) gives each round and its observed limitation.

Model output was variable. One run inferred that an earlier mistake persisted even though later replies only said “收到”; the rubric now requires a substantive answer before judging persistence. A later run asked the user to relax a synthetic test constraint; the rubric now rules that out. The final observed review distinguished the unsupported math claim, review text inserted into an acknowledgment reply, and correction status that had not been verified. The prompt does not guarantee every future review will make those distinctions.

The original 2.0.0 baseline and its old test failures are preserved in [the baseline validation record](VALIDATION-2.0-BASELINE.md) and Git commit `4b301cbd4d9c51a680057755feedb115f3b9dd03`. The legacy runner is retained for migration work; some older test files were updated for 2.1.0 and the old suite is not this version's acceptance suite.

Still unverified: a clean install on another machine, other Harness versions/platforms, long-running monitoring, arbitrary model judgment quality, and automatic removal of sensitive material. The selected evidence is processed by the configured model provider, which may be remote; see [privacy notes](PRIVACY.md).
