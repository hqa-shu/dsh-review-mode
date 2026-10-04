# Review flow · development acceptance guide

This describes the intended user flow. Passing code checks does not prove the real desktop UI follows every step.

1. Install and enable the local bundle; restart the host after code changes.
2. Start an `审核模式` session. The opening points toward the review panel.
3. Choose current DSH, another DSH, or Codex in the panel.
4. For another conversation, select one identifiable target; verify the title and source.
5. The host prepares evidence and dispatches a reviewer. Pending means dispatched/in progress, not completed.
6. The panel shows quotes, recap, analysis and advice, or an explicit failure.
7. New user messages on the selected target trigger review edges. Idle polling should not produce repeated reviews.
8. Switch target or return using panel navigation, and verify new results belong to the new target.

| State | User action | Host command / result |
| --- | --- | --- |
| 1 | Choose source | `dir self`, `dir dsh`, or `dir codex` |
| 2 | Pick an external conversation | `pick` updates shared target and dispatches review |
| 3 | Read the analysis and ask a follow-up | Panel uses `ask` / status commands; preserve selected-target identity |

Other text requests use the review tools and should reach the same result panel. Validate this path separately from panel clicks. Known failures and test scope are in [docs/VALIDATION.md](docs/VALIDATION.md).
