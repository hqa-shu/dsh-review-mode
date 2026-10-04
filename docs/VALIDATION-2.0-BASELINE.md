# Validation of the development snapshot

Historical 2.0.0 record. Its exact source and tests are available at Git commit `4b301cbd4d9c51a680057755feedb115f3b9dd03`; this file does not describe the current 2.1.0 acceptance results. See [VALIDATION.md](VALIDATION.md) for those.

Date: **2026-10-04**. Runtime: Node.js `v24.19.0`, macOS arm64, SDK read from DeepSeek Harness Desktop `0.2.0-rc.2`.

## Results

- SDK preparation: **33 packages** prepared from the installed application's ASAR; no SDK files are committed.
- Syntax, runtime package-file inclusion, basic private-data scan, and development-status checks: **passed**.
- Existing regression suite: **36 of 41 test files passed; 5 failed**.
- Clean-checkout portable smoke subset: **8 of 8 passed** without the host SDK. This is a subset of the suite, not additional coverage or a full health certificate.
- Model calls: **zero**. Conversation records are synthetic and home-directory discovery is redirected inside test subprocesses.

The candidate, legacy-remote and step10 tests initially failed because the public test fixtures/documentation were incomplete. They passed after adding enough synthetic Codex records, a synthetic DSH record, and the public flow guide. Runtime code was unchanged. Four more tests pass with the prepared host SDK but cannot run in the clean-checkout portable subset. [Machine-readable results](validation-results.json) list each file.

## Remaining failures

| Test file | Observed assertion failure |
| --- | --- |
| `client-test.mjs` | The expected four analysis anchors/content are absent in the tested panel state |
| `panel-rows-test.mjs` | Expected latest-card analysis, conclusion and question area are missing in the tested detail view |
| `ping-test.mjs` | The expected last-scan metadata is null instead of matching the seeded directory |
| `qa-ask-test.mjs` | Question and answer are not found below the expected left-side input area |
| `qa-panel-test.mjs` | The question box is not found in the expected left column |

These may reflect actual defects, outdated expectations, or incomplete test doubles; that distinction has not been established for this publication. The failing tests remain in the repository, and the default regression command returns a failing exit code. CI runs source checks and the explicitly named portable smoke subset only.

## What this does not verify

- Clean installation by another user or on another host/platform.
- Real desktop rendering, model credentials, streaming provider behavior or review accuracy.
- Production privacy/security, resistance to prompt injection, or automatic secret redaction.
- Compatibility with later Harness builds or changed Codex session formats.

This is a source snapshot under active development. A green smoke workflow does not mean the complete plugin is stable.
