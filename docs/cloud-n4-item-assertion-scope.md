# Cloud N4.3 / N4.4 item assertion scope

Base: main `23083b3a8cb0a9ddb4c66d9a24b2b4a8798fdf7b`, v0.1.20,
109/160 (68.125%). N4.3 and N4.4 are already met at their bounded historical
evidence. This independent branch does not award new condition credit or edit
the shared progress ledger, frozen criteria, protocol or original 22-row corpus.

## Inventory frozen before baseline

Read the frozen N4 requirements, `narrative-fixed-corpus.md`,
`narrative-three-worlds.md`, `CLAUDE-HANDOFF.md`, the firewall and existing
item/speech/presence/sensory tests. The original five categories have paired
coverage, but these specific variants have no explicit paired expectation:

- Hypothetical item states introduced by 如果 / 假如 / 要是 versus a subsequent
  independent current-state assertion. A hypothetical must not be mistaken for
  a repair, and cannot authorize a contradictory later clause.
- Passive current states (被损毁 / 被损坏), each supported and contradicted by
  Core, plus passive denial supported and contradicted by Core.
- Typed retelling of the same passive claim versus a later unquoted identical
  claim. Speech masking must authorize only its one ordered occurrence.

The 14 exact text/state/expected-result rows are frozen in
`tests/fixtures/narrative-item-assertion-corpus.ts` before changing product code.
Run unchanged-code commerce validator and disk cases first. Then run the exact
same rows in all three existing structurally witnessed worlds: commerce,
relationships, autonomy. Keep each validator read-only; disk INSPECT must retain
entities, advance exactly one minute/revision, produce one own receipt and
replay its saved response/bytes without generation after service recreation.
The permissive offline audit cannot override contradictory Core state.

These new disk rows cover normal/degraded presentation and replay. The existing
three-world boundary suite supplies ambiguity, missing-speaker, refusal and
before/after-write fault controls; do not call every new row an HTTP/fault test.
No production data, port 3100, paid Provider, arbitrary-language or human prose
acceptance is part of this batch.

## Observed baseline and repair boundary

Unchanged implementation, Commerce only (14 validator + 14 disk rows):
**14 passed / 14 failed / 56 excluded**, 103.05s total including import/transform.
The seven actual failing samples each reproduce in both validation and storage:
all three hypotheses are falsely rejected; invented passive damage/destruction,
contradicted passive denial and the external claim after typed speech escape the
guard. The lawful/current-state controls and independent-tail refusals pass.

Retained local reports under `.agent-runtime/codex/`:

- `cloud-n4-baseline.json`: initial name filter matched zero tests (84 excluded);
  not acceptance evidence.
- `cloud-n4-baseline-commerce.json`: 12 passed / 16 failed / 56 excluded; two
  failures hit the default 5s runner timeout. No expectations changed.
- `cloud-n4-baseline-commerce-timed.json`: the same 28 selected rows with a 30s
  runner timeout, 14 passed / 14 failed / 56 excluded. Both timed-out controls
  pass; the remaining failures are the reproduced product counterexamples.

Product repair is confined to `validateItemConditionNarrative` in
`src/core/narrative-firewall.ts`: recognize the immediate passive marker 被
before existing state predicates, retaining existing negation parity and Core
comparison. Skip only an occurrence whose same-clause prefix is exactly
如果 / 假如 / 要是. Continue scanning every later occurrence. Existing ordered
typed-speech masking, actor presence/perception, public-item visibility,
duplicate-name conservatism, receipts and settlement are unchanged.

This is a bounded assertion-scope repair. It is not a general conditional
parser, a historical-state verifier, proof of arbitrary paraphrase coverage or
permission to treat a hypothetical state as canonical.

## Verified extension

`cloud-n4-fixed.json`: **84 passed / 0 failed / 0 skipped**, 263.862s including
import/transform and concurrent build contention. The unchanged 14 samples ran
as 42 read-only validator cases and 42 actual JsonStore/service cases in the
same three existing witnessed structures. Lawful hypotheses/retelling remain
normal; contradictions degrade after three bounded generations even with a
permissive audit. Every disk row verifies one own INSPECT receipt, one minute,
one revision, unchanged canonical entities and fresh-service exact response/
byte replay without additional generation.

`cloud-n4-adjacent.json`: **7 files / 173 passed / 0 failed / 0 skipped**,
168.598s including import/transform and concurrent build contention. Includes
the original fixed corpus, item-condition, typed-speech occurrence, three-world
validator and boundary matrices, sensory similes and inventory-denial controls.
Together these are 257 distinct selected tests, not a whole-project suite.

The isolated `build` completed successfully: strict root TypeScript, Vite
production frontend and server TypeScript. Vite emitted dependency annotation
and bundle-size warnings; they did not fail the build and are unrelated to this
repair. The progress `--check` remains 109 met / 22 unmet / 29 unverified,
68.125%; no additional credit is claimed.

After these runs, the two new parameterized test groups explicitly declare the
same 30s runner deadline previously supplied by CLI. This changes no assertion
or application timeout. The 84-row report precedes this deadline-only edit;
the two formerly timed-out disk controls are rerun without a CLI timeout
override in `cloud-n4-declared-deadline.json`.
That final targeted run passed both selected controls (2 passed / 0 failed /
82 deliberately excluded); it is not counted as additional distinct coverage.

Reproduction from the checkout named `game` (the workspace runner checks its
real basename), Node.js 24.19.0 / npm 11.9.0, Linux:

```sh
npm ci --cache /workspace/.npm-cache --no-audit --no-fund
node scripts/agent-workspace.mjs codex test tests/narrative-item-assertion-scope.test.ts --testTimeout=30000 --reporter=json --outputFile=.agent-runtime/codex/cloud-n4-fixed.json
node scripts/agent-workspace.mjs codex test tests/narrative-fixed-corpus.test.ts tests/item-condition-narrative.test.ts tests/typed-speech-occurrence-scope.test.ts tests/narrative-three-worlds.test.ts tests/narrative-three-world-boundaries.test.ts tests/perception-simile-authority.test.ts tests/inventory-denial-prose.test.ts --testTimeout=30000 --reporter=json --outputFile=.agent-runtime/codex/cloud-n4-adjacent.json
node scripts/agent-workspace.mjs codex build
node scripts/four-theme-progress.mjs --check
```

The runner sets Mock and private data/log/tmp paths in `.agent-runtime/codex`.
No application server is started by these commands. Test-created services use
temporary stores and are not deployments. Reports stay ignored; fixtures and
assertions are committed for independent reproduction.
