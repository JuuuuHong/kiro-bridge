---
name: setup
description: Check kiro-bridge's installation state and install Kiro custom agents. Run this before first use, after updating kiro-cli, or when a review fails with TOOL_DENIED.
argument-hint: "[--force]"
---

# kiro-bridge:setup

## Running it

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" setup [--force]
```

Prints `✓`/`✗` per step. Stops on version or authentication failure;
a failed ACP transport probe records a warning, falls back to subprocess, and
continues with agent installation.

| Step | What it checks | On failure |
|---|---|---|
| `version` | `kiro-cli --version` | Show install guidance and stop |
| `auth` | `kiro-cli whoami` | Show `kiro-cli login` guidance and stop |
| `transport` | ACP handshake → decides acp / subprocess | Continues via fallback |
| `agent:reviewer` | Render agent → `agent validate` → install | Reports failure with attempt history |

While unauthenticated, **agents are not installed.** This avoids leaving a
half-finished install state behind.

## Child-environment isolation & `~/.kiro-bridge/config.json`

Every kiro-cli spawn/exec runs with an explicit allowlisted environment, not the
inherited parent environment. The defaults forward only what a normal CLI needs
(`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, temp dir, `LANG`/`LANGUAGE`
+ the `LC_*` prefix, proxy vars, CA-bundle/TLS-trust vars, `KIRO_AGENTS_DIR`,
and the `XDG_` prefix), never forward `KIRO_BRIDGE_HOME` or an inherited `PWD`,
and force `NO_COLOR=1`.

Credential-bearing and runtime-injection variables are **hard-denied** and can
never be forwarded — AWS credential/token vars and the container/IMDS credential
endpoints, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `NPM_TOKEN`,
`SSH_AUTH_SOCK`, `NODE_OPTIONS`, `FORCE_COLOR`, and npm config injection
(`npm_*`, `NPM_CONFIG_*`).

To forward an extra variable, add its **exact name** to `envPassthrough` in
`~/.kiro-bridge/config.json` (no wildcards, no globs):

```json
{
  "envPassthrough": ["AWS_PROFILE", "AWS_REGION"]
}
```

Precedence is **deny > (default-allow | passthrough)** — the hard-deny floor is
applied last, so a passthrough entry can never re-introduce a credential
variable such as `AWS_SECRET_ACCESS_KEY`. `envPassthrough` is only for
non-secret selectors like `AWS_PROFILE` or `AWS_REGION`.

## Tool-naming convention probe

Kiro's canonical tool names are inconsistent across docs — the
`--trust-tools` help example uses `fs_read,fs_write`, but the `session/new`
response's built-in list is `read, write, grep...`.

setup doesn't guess this — it **runs both conventions through `agent
validate` in order** and adopts whichever passes. The result is recorded as
`toolNaming` in `~/.kiro-bridge/config.json`, so it isn't re-probed on the next run.

If both fail, installation stops and the attempt history is reported. In
that case Kiro's version has changed and the tool naming scheme has shifted
again, so a new convention needs to be added to `TOOL_NAME_SETS` in `agents.mjs`.

## Installed agents

`~/.kiro/agents/kiro-bridge-reviewer.json` — the `kiro-bridge-` prefix avoids
name collisions in the user's own agent space.

Permissions (ADR-002):

- Trusted: `read`, `grep`, `glob` — **explicitly** pre-trusted
- Untrusted: `write`, `shell`

The reason for explicitly trusting reads matters. In non-interactive mode, an
untrusted tool call is not asked about — it's **auto-denied and the
conversation continues.** So "trust nothing" isn't safety, it's silent
functional failure — the reviewer produces plausible-sounding findings
without ever having read the file.

## User-modified agents

Agent JSON carries a version and a body hash stamp. If the user has touched
the file, the hash no longer matches, and setup **skips it without
overwriting, and warns.**

```
✓ agent:reviewer: skipped (tool convention: short) → ... — user-modified — not overwritten
```

If you see this message, notify the user and ask whether to overwrite. Don't
append `--force` on your own — the user may have deliberately tuned the
prompt or permissions.

## When to run it again

- Before first use
- After a `kiro-cli` update (the capability cache auto-invalidates by
  version, but the agent schema itself may have changed)
- When a review fails with `[TOOL_DENIED]` — a signal that permission setup is broken
