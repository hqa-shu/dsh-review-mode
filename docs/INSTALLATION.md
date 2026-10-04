# Installation · 安装

Status: **development snapshot**. Baseline: DeepSeek Harness Desktop `0.2.0-rc.2`, macOS arm64. Node.js 24+ is required for the scripts. This guide was prepared from the installed host package and local profile structure; fresh installation on another computer remains unverified.

## 1. Clone and prepare dependencies

```sh
git clone https://github.com/hqa-shu/dsh-review-mode.git
cd dsh-review-mode
node scripts/prepare-runtime.mjs
node scripts/check.mjs
node scripts/run-tests.mjs
```

The default SDK source is `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`. For a different path:

```sh
node scripts/prepare-runtime.mjs --asar /absolute/path/to/app.asar
```

Only selected packages and their dependency closure are extracted. Existing package directories are retained; rerun in a fresh checkout after a host upgrade. No application files, profile files, credentials, or sessions are edited. The script performs no network requests and runs no dependency lifecycle scripts.

The package manifest also declares its required Typert SDK dependency. Registry-only dependency installation has not been validated for this snapshot; the local SDK preparation path is the baseline.

## 2. Install as a local bundle

In Harness, open the sidebar's **Plugins** page and install the checkout's absolute directory path. The package name is `@local/dsh-review-mode`. The bundle patch contributes two entries:

- `preset-review`: the selectable `review` agent preset.
- `review-mode`: the host review engine.

The client entry is declared in `package.json` and loads separately. Do not add a third-party `remote.reviewRemote` service to the client's hard dependency list: the panel uses the host's existing commands channel.

The profile's package manifest should contain a local link and the selected bundle. See [examples/profile.package.json](../examples/profile.package.json). Replace the placeholder path with your checkout. Preserve other existing profile dependencies and bundles.

**The profile is shared across sessions.** Installing or disabling a bundle affects all sessions using it. The host executes plugin code with host permissions; the reviewer's lack of tools does not sandbox the host plugin.

## 3. Configure and restart

If needed, merge the override from [examples/cordis.patch.yml](../examples/cordis.patch.yml) into the existing profile patch. Do not replace the whole profile with the example. The sample conservatively disables automatic Codex monitoring; the implementation defaults enable it.

Restart Harness after host-code changes. ESM module caching can leave old host code running after a disable/enable toggle. Refresh the UI after client edits and check the panel's version diagnostics.

## 4. Verify the user flow

1. Create an **审核模式** session.
2. Confirm the review panel appears beside the conversation.
3. Select the current session, another DSH session, or a Codex conversation.
4. Confirm the selected target matches the requested conversation.
5. Check that reviewing, failure, and ready states report the actual outcome.
6. Use a non-sensitive synthetic conversation before real work.

Review evidence is processed by the configured model provider. Read [PRIVACY.md](PRIVACY.md) before selecting personal or confidential conversations.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `ERR_MODULE_NOT_FOUND` for Typert | Run SDK preparation from the matching host build; confirm `remote.js` is present |
| Preset missing | Bundle enabled, two patch rows load, and host startup reports no import/schema error |
| UI fails to start | Keep optional remote services out of the client's hard `inject` list |
| No Codex targets | Local `~/.codex` records exist and discovery supports their format |
| Panel never finishes | Inspect the reported failure and model availability; do not treat pending as success |
| Edits have no effect | Restart Harness and compare running identity with disk identity |

Upstream reference: [Harness plugin manager](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/services/plugin-manager). The installed SDK `0.2.0-rc.2` package README is the baseline used for this guide.
