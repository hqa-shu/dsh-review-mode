# Architecture

This snapshot has three layers: host orchestration, evidence/rubric logic, and a web client panel.

1. The bundle declares a review preset and host engine. The client module registers its panel slots separately.
2. Selection updates shared target state. Current DSH, other DSH, and Codex targets use the same review-dispatch pipeline.
3. Local records are turned into evidence. Codex discovery reads session metadata and merges rollout segments by thread identity; DSH records use their session representation.
4. A reviewer subagent receives prepared evidence and output instructions. It does not inherit the full parent context and has an empty tool allowlist.
5. Output is parsed, folded into the `reviewMode` projection, and rendered in the panel. Delivery and projection code must remain consistent with the host's session format.
6. Monitoring detects new user-message edges. Polling alone should not imply another model review.

## Engineering constraints

- Host SDK imports resolve from the plugin directory. `remote.js` imports the Typert protocol even though its legacy remote-service class is retained rather than used as the panel's primary transport.
- The panel uses the official commands channel. Third-party remote namespaces are not automatically discoverable by the shipped client.
- Runtime identity distinguishes code loaded into the process from newer files on disk.
- Projection state preserves partial progress and explicit failures; a UI spinner is not evidence of a successful dispatch.
- A reviewer cannot see evidence that was omitted. The rubric should express uncertainty rather than infer that an omitted action did not happen.

## Snapshot fidelity

The runtime files are copied unchanged from the local development snapshot. [source-snapshot.json](source-snapshot.json) records their hashes and packaging changes. Public docs replace private development narratives; test-fixture absolute paths are normalized. Personal logs, recorded review outputs, screenshots, and session-specific replay scripts are excluded.

This repository is a snapshot, not an automatic mirror of the live development directory. Some comments describe earlier designs and may conflict with current behavior; tests and executable paths are the stronger evidence. Removing legacy transport code and reconciling those comments are roadmap items.
