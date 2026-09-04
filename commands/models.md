---
description: List the model ids this kiro-cli accepts for --model
argument-hint: "[--force]"
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" models` and report the
result as-is. The list comes from kiro-cli itself and is cached per kiro-cli
version for a day; pass `--force` to re-read it (e.g. after a preview model was
enabled or withdrawn on the account).

Use this whenever a request names a model loosely — "sol", "opus", "the cheap
one". Map that shorthand onto a real id from this list before passing `--model`
to any kiro-bridge command; never guess an id.
