# Contributing

This project is under active development. Small, reproducible contributions are especially helpful.

1. Read the installation and privacy guides.
2. Prepare the local SDK and run `node scripts/check.mjs` and `node scripts/run-tests.mjs`.
3. For a bug, provide the host version, platform, selected target kind, steps, expected result and actual result.
4. Use synthetic conversation excerpts; remove personal paths and credentials from diagnostic snippets.
5. Keep changes focused and explain how they were checked. State whether validation used doubles, local fixtures, or the real host UI.

The default tests isolate conversation discovery from the user's real home directory. Integration tests use seeded records and the host SDK; they do not call a real model. Some retained tests describe historical behavior and can fail against the current snapshot; consult the validation report.

No project license has been selected yet. Discuss substantial reusable contributions with the maintainer before submitting them.
