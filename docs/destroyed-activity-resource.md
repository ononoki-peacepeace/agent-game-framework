# Registered activity resource validity

Parent checkpoint: `39fb322`. A nearby or held registered instrument previously authorized playing even when destroyed. Static location text could also override that canonical condition. The actual execution-first baseline failed both scene/held cases, with two usable controls passing (4.496s); an earlier availability-first baseline also failed two cases (4.617s). Reports remain in `.agent-runtime/codex/`.

`activityRequirement` now requires at least one matching registered resource that is not destroyed and has accessible, unsealed container ancestry. A static location description is used only when no matching registered local/held resource exists. Described scenery still supports ordinary activity without creating inventory; damaged instruments remain usable under the existing condition semantics. Canonical entity lookup supplies the existing container helper. No schema, effect, NPC reaction or world result is added.

Actual verification:

- First fixed selection: 3 files, 26/26 passed, zero skips, 10.840s (`destroyed-activity-resource-fixed.json`).
- Adjacent activity interruption, environment HTTP and completion selection: 5 files, 77/77 passed, zero skips, 48.035s (`destroyed-resource-adjacent.json`).
- Strict TypeScript initially failed, exit 2, 60.900s: a projected Entity was passed to the canonical SavePackage helper. Fixed by looking up the canonical entity ID; no behavior assertion was relaxed.
- Final source direct cases: 8/8 passed, zero skips, 4.520s (`destroyed-resource-canonical-final.json`), including actual synthetic disk/service recreation with unchanged bytes and zero generation. Final strict TypeScript: exit 0, 40.891s (`destroyed-resource-typecheck-final.json`).

The adjacent selections precede the final canonical-lookup type fix; they are retained evidence, not a claim that eight files were rerun on final source. No new complete build or full-suite claim. A8.3 remains unmet: broader dynamic object, terrain, capability and time-advance resource changes remain open. Fixed acceptance remains 103/160 (64.375%), delta zero.
