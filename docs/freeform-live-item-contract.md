# Live item operation contracts before result RNG

Parent `75f5511`. Actual baseline `freeform-live-item-baseline.json`: **2 failures/4 controls, 4.829s**. If a time hook destroys a damage target, the eventual generic assertion yields GameError rather than the structured world refusal. If a hook seals the storage destination, rejection occurs after one action-result RNG call. Both original saves remain unchanged already; this batch does not claim that the old paths committed partial mutations.

Freeform now rejects an already-destroyed live damage target and rebinds storage roles/capability after time advancement, before action RNG. A newly sealed destination or invalid container role raises WorldBlockedError. Existing item access/ancestry revalidation remains; supported open storage and damage still roll once. No item is repaired, created or consumed by this change; schema/API/commit semantics unchanged.

The declared-character-capability enabled/disabled pair already passed at baseline and remains a positive control, proving post-time capability revalidation without inferring ability from prose.

Actual reports under `.agent-runtime/codex/`:

- `freeform-live-item-fixed.json`: **4 files/49 passed**, zero skips, **14.483s**, including existing storage, sealed movement and sealed damage.
- `freeform-live-item-expanded.json`: **9/9 passed**, zero skips, **6.840s**, including a destination losing its container role and real synthetic JsonStore/service recreation for both failure paths. Repeated refusals preserve exact bytes/time/item conditions/receipts, invoke no Narrator and make zero live Provider calls.
- First strict TypeScript exit 0, 42.619s, precedes test expansion. Final expanded strict exit 0, **47.923s**, `freeform-live-item-typecheck-final.json`.

Selected passing union: four files/52 distinct cases, not one full-suite/build result. A8.3 remains unmet; the broader dynamic item/terrain/capability and consumption breadth is not closed by these cases. Fixed progress 103/160 (64.375%), delta zero. Original six dirty files, formal save, 3100 and frozen criteria remain unchanged.
