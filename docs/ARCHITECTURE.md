# Architecture

Version 2.1.0's current contract is summarized in [CURRENT-IMPLEMENTATION.md](../CURRENT-IMPLEMENTATION.md). The design below describes the same host/client split; older transport notes are retained only in the [2.0.0 baseline record](VALIDATION-2.0-BASELINE.md).

This snapshot has three layers: host orchestration, evidence/rubric logic, and a web client panel.

1. The bundle declares a review preset and host engine. The client module registers its panel slots separately.
2. Selection updates shared target state. Current DSH, other DSH, and Codex targets use the same review-dispatch pipeline.
3. Local records are turned into evidence. Codex discovery reads session metadata and merges rollout segments by thread identity; DSH records use their session representation.
4. A reviewer subagent receives prepared evidence and output instructions. It does not inherit the full parent context and has an empty tool allowlist.
5. Output is parsed, folded into the `reviewMode` projection, and rendered in the panel. Delivery and projection code must remain consistent with the host's session format.
6. Monitoring detects new user-message edges. Polling alone should not imply another model review.

## Engineering constraints

- The runtime uses host-injected services and Node built-ins. `remote.js` contains local target/query helpers; the unusable legacy Typert remote-service class was removed in 2.1.0.
- The panel uses the official commands channel. Third-party remote namespaces are not automatically discoverable by the shipped client.
- Runtime identity distinguishes code loaded into the process from newer files on disk.
- Projection state preserves partial progress and explicit failures; a UI spinner is not evidence of a successful dispatch.
- A reviewer cannot see evidence that was omitted. The rubric should express uncertainty rather than infer that an omitted action did not happen.

## Snapshot fidelity

The original [source-snapshot.json](source-snapshot.json) records the 2.0.0 baseline hashes. [source-snapshot-2.1.json](source-snapshot-2.1.json) records the current runtime file hashes. Version 2.1.0 was merged from the installed plugin's tested working copy; personal logs, recorded review outputs, screenshots, and session-specific replay scripts are excluded.

This repository is a snapshot, not an automatic mirror of the live development directory. Some comments describe earlier designs and may conflict with current behavior; tests and executable paths are the stronger evidence. Removing legacy transport code and reconciling those comments are roadmap items.
