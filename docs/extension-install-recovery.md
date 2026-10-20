# Extension installation recovery

Codex owns this reliability boundary. The shared starting commit is
`a838b11eb9fd8f4a4d92b39282808e88a57baa7e`; Claude's independent branch does
not need these changes for its existing build. Integrate the builder and task
changes together before using the new task recovery method.

An extension candidate records its originating `game_id`. Loaded job journals
are schema checked and candidate workspaces must match a generated job or task
directory. A legacy candidate without world identity remains visible but loses
installation eligibility. Installation verifies the artifact's real path,
hash and manifest before preparing its durable installation intent.

`DevelopmentTask.extension_install` is optional, so existing task records remain
readable. It binds the candidate job, normalized installation request and goal
callback state. The task intent is durable before builder dispatch. The builder
intent is durable before approval or world installation. Predictable revision,
world, candidate and migration-confirmation failures are checked before the task
intent is written. A race or failure after preparation terminates conservatively.

Recovery uses the existing Core request receipt: request ID, operation
fingerprint, expected revision, Undo validity and the current installed manifest
must agree. `ExtensionDevelopment.recoverInstallation` reads storage and returns
the verified save or null; it cannot approve, install, migrate, rebuild or invoke
a goal. A matching manifest alone does not prove a newly prepared installation.
The task's original request may return the current projected world after
reconciliation. A different request or changed arguments cannot claim that result.

Before the original goal callback runs, its state is durably `started`. Completion
or failure is recorded separately. Callback journal failures propagate rather than
being swallowed as callback exceptions. Restart and duplicate installation never
invoke that callback, including when its last durable state was `not_started`.
This favors safe termination over silently replaying a possibly settled goal.
An uncertain prepared installation cannot use ordinary task resume to rebuild;
the caller must inspect the original result or explicitly revise requirements.

Tests inject lost responses after world persistence, builder/task journal faults,
callback-start and callback-completion faults, missing/wrong receipts, Undo,
removal, stale revisions, conflicting request IDs and restart. Candidate compilation
uses the real local TypeScript executable; AI generation is an offline fixture.
Capability/core installation command-substitute tests remain separate evidence.

Limits: no process-kill, power-loss or cross-process locking acceptance; no full
workspace symlink/TOCTOU guarantee; no automatic continuation of interrupted goal
callbacks. The job journal retains only its existing bounded recent history, so
an evicted candidate cannot be recovered automatically. A client that lost the
original request identity needs explicit inspection rather than a fresh install.
No production save, paid provider or deployment is involved.
