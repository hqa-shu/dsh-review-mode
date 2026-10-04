# Configuration

Merge the following entry into the profile's `cordis.patch.yml`; keep existing profile entries. The example file is [examples/cordis.patch.yml](../examples/cordis.patch.yml). Runtime defaults below come from `resolveConfig()` in `index.js`.

| Key | Default | Meaning / accepted range |
| --- | --- | --- |
| `preset` | `review` | Nonempty preset id |
| `minToolCalls` | `1` | Minimum tool calls for the turn-stop path; integer ≥ 1 |
| `provider` | `spawn` | Subagent provider id, distinct from the model provider |
| `reviewTimeoutMs` | `180000` | Positive timeout in milliseconds |
| `eventScanLimit` | `4000` | Event scan bound; integer ≥ 20 |
| `codex` | `true` | Enable Codex evidence in the turn-review path |
| `codexWindowHours` | `12` | Positive freshness window for that evidence path |
| `codexFiles` | `2` | Rollout-file bound for that evidence path; integer ≥ 1 |
| `codexTailBytes` | `524288` | Tail-read limit; integer ≥ 8192 |
| `digestBudgetChars` | `7000` | Turn-review evidence budget; integer ≥ 1500; not a token count |
| `watchCodex` | `true` | Enable selected-target automatic monitoring |
| `watchIntervalMs` | `5000` | Detection interval; integer ≥ 1000 |

Invalid values fall back to defaults. This snapshot accepts raw loader configuration; it does not expose a full settings schema. Some evidence limits belong to the turn-review path and do not impose a universal bound on every panel operation.

## Model selection

The review dispatch tries to inherit the relevant conversation's model configuration while keeping review context separate. `provider: spawn` selects the subagent mechanism, not a model brand. Model availability and authentication are managed by Harness; do not store API keys in this repository or the example patch.

## Rubric and output

`rubric.js` owns the review instructions and output parser. Review perspectives are `me`, `conversation`, and `agent`. The four display sections are quoted conversation, recap, analysis, and advice. Conclusions include `on-track`, `drifting`, `off-track`, and `unknown`; incomplete evidence should remain explicit.

## Conservative first run

The example uses `codex: false` and `watchCodex: false` to disable background Codex observation initially. These toggles are **not access-control boundaries**: a user can still explicitly select a local target through the panel/tools. For sensitive content, avoid selecting it and check the model provider first.
