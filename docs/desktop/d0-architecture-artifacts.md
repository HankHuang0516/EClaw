# Desktop D0 Architecture Artifact Pack

- **Status:** Ready for D0 review
- **PR:** #2942
- **Owner:** Codex #6
- **Reviewer:** LOBSTER #2
- **Parent card:** `card_b0568b17e0380ad25effe79b` - `[Roadmap/Desktop] D0 - spike / architecture gate`
- **Blocks:** D1 desktop core infrastructure (`card_1434b0534bfb8a9871276c7f`)
- **Primary ADR:** `docs/desktop-app-adr-001-framework.md`
- **CI guard:** `.github/workflows/desktop-d0-ci.yml`

## Gate Decision

D0 is an architecture gate, not the desktop implementation. The accepted
decision is:

- Framework: Tauri 2.
- UI model: local EClaw-owned bundle with restrictive CSP.
- Privilege model: narrow Rust commands only, with schema validation and no
  generic filesystem, shell, process, or token readback authority.
- OAuth model: system browser Authorization Code + PKCE, random loopback port,
  strict `state` and `nonce`, and a short-lived single-use listener.
- Token model: refresh tokens only in OS credential storage; access tokens only
  in memory through the Rust layer.
- Update model: signed update artifacts over HTTPS, pinned updater public key,
  and dynamic rollback allowlisting only for affected cohorts.
- Rollback model: installer, updater, binding config, and uninstall steps are
  manifest-driven and reversible.

## Submitted Artifacts

| Artifact | Location | Review question |
| --- | --- | --- |
| Framework ADR | `docs/desktop-app-adr-001-framework.md` | Is Tauri 2 the accepted D1 base instead of Electron? |
| Threat model | `docs/desktop-app-adr-001-framework.md#threat-model` | Are the critical desktop trust boundaries and controls explicit enough for D1? |
| Rollback and uninstall spec | `docs/desktop-app-adr-001-framework.md#rollback-and-uninstall-spec` | Can D1 implement installer/update/config/uninstall recovery without another architecture pass? |
| PoC scope plan | `docs/desktop-app-adr-001-framework.md#poc-scope-plan` | Is the follow-up smoke proof bounded and testable? |
| CI artifact guard | `.github/workflows/desktop-d0-ci.yml` | Does the PR get a real status check for the docs-only D0 gate? |

## D1 Entry Criteria

D1 may start after all of these are true:

- PR #2942 is merged with reviewer acceptance of the Tauri 2 architecture.
- Review comments on the ADR, threat model, and rollback/uninstall scope are
  resolved.
- The D1 implementation card links back to this artifact pack and keeps the
  listed security controls as non-optional acceptance criteria.
- The PoC card tracks the clean macOS and Windows install -> OAuth -> bind ->
  uninstall evidence as a follow-up gate before D1 is called unblocked.

D1 must not ship or claim the desktop foundation is complete until the PoC
evidence proves token storage, one-agent binding, rollback, and uninstall
cleanup on clean macOS and Windows environments.

## Follow-Up Scope

The follow-up `eclaw-desktop-spike` scope should stay separate from this PR and
prove:

- A minimal local Tauri 2 shell can render EClaw UI assets without remote
  privileged content.
- OAuth completes through the system browser with PKCE and loopback validation.
- A test refresh token is stored through OS credential storage and cannot be
  read directly by the renderer.
- One staging agent bind path performs detect -> backup -> write -> validate ->
  bind -> verify, and restores local config on forced failure.
- Installer/update failure recovers to the previous active version or a clean
  no-install state.
- Uninstall removes app files, update cache, launch/startup entries, protocol
  handlers, local app data, rollback manifests, temporary backups, and EClaw
  credential-store entries.
- Redacted smoke evidence is attached for clean macOS and Windows VM runs.

## Review Checklist

- The decision is intentionally small enough for review: architecture and
  guardrails only, no app scaffold.
- The accepted framework decision is explicit and reversible only by a new ADR.
- The threat model covers the desktop-specific risks that would be expensive to
  retrofit after D1 starts.
- The rollback and uninstall requirements define the observable proof needed
  before D1 is unblocked.
- CI now has a docs-only status check so the PR is not invisible to Actions.

## CI Evidence

`Desktop D0 CI` runs `node scripts/validate-desktop-d0-artifacts.js` on changes
to this artifact pack, the ADR, the validation script, or the workflow itself.
The check is deliberately dependency-free so it can run quickly on a docs-only
PR while still proving the D0 gate has the required artifact surface.
