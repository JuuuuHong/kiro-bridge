# Security Policy

## Supported versions

Only the latest release on `main` receives fixes. There are no long-lived
maintenance branches.

## Reporting a vulnerability

Report privately through GitHub: **Security → Advisories → Report a
vulnerability** on this repository. Please do not open a public issue for
anything that looks exploitable.

Useful details: the kiro-cli version, the bridge version, the command you ran,
and the smallest input that reproduces it. A repository or diff that triggers
the behaviour is more useful than a description of it.

Expect an initial reply within a week. This is a personal project, so there is
no formal SLA beyond that and no bug bounty.

## What counts as a vulnerability here

The bridge's claimed boundaries are in [README](README.md#security-model) and
[`docs/decisions/`](docs/decisions/). A report is in scope when it breaks one
of them, for example:

- Escaping the read-only default — a delegated call reaching write, execute, or
  shell tools that the agent spec does not grant (ADR-002).
- A silent tool denial passing as a successful result rather than escalating to
  an explicit permission error (ADR-002).
- Kiro output taking effect as a command instead of data: trust-boundary
  wrapping bypassed, schema sanitization evaded, or findings auto-applied
  (ADR-004).
- Terminal control sequences surviving to stdout/stderr — ANSI CSI, OSC
  (including OSC 52 clipboard), DCS/PM/APC/SOS, or C0/C1 bytes.
- A credential or denied variable reaching the child environment despite the
  allowlist and its hard-deny floor, including via `envPassthrough`.
- A project-level `.kiro/settings/kiro-bridge.json` doing anything but
  *tightening* — relaxing redaction, widening passthrough, or writing the
  capability cache.
- Secrets leaving in a bridge-built payload that the redaction pass should have
  masked.
- Path traversal out of the cwd-scoped job or session directories, or a
  recorded session file holding prompts, diffs, paths, or model output.

## What does not

These are documented design limits, not defects:

- **Bridge redaction covers only the payload the bridge assembles.** Files Kiro
  reads through its own tools never pass through it.
- **This is not an OS-level sandbox.** Permissions are a Kiro-level tool-trust
  configuration. A kiro-cli or model that ignores its own trust model is an
  upstream issue — report it to Kiro.
- **`task --write` modifies files on purpose.** It is an explicit, opt-in mode;
  review its diff before accepting the change.
- **Prompt injection that only influences Kiro's answer.** Model output is
  treated as untrusted data by design. It becomes a report here when the
  injected text escapes the trust boundary — not when it merely produces a
  wrong or hostile-sounding answer.
- Anything requiring an attacker who already has write access to your home
  directory or your kiro-cli credentials.
