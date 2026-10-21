# Storage choices use the canonical sealed access rules

Parent `7694341`. Actual baseline `sealed-storage-binding-baseline.json`: **4 failures/6 controls, 5.518s**. Shared binding marked source contents behind a sealed ancestor and sealed destination containers usable in both held and scene variants. Choice filtering trusted that binding, although execution already refused. Open source/destination controls and moving an empty sealed container by its exterior passed.

`bindStorageAction` now includes existing unsealed ancestry and destination own-seal prerequisites in role usability, with a precise reason for refusal. This aligns offered choices and execution without hiding known objects or preventing exterior movement. The helper remains pure; no world/schema/API/Core commit changes.

Actual `.agent-runtime/codex/` reports: `sealed-storage-binding-fixed.json` **4 files/54 passed**, zero skips, **14.239s**; `sealed-storage-binding-expanded.json` **2 files/21 passed**, zero skips, **8.437s**. Twelve direct cases include both real JsonStore/service recreations with identical file bytes, zero generation, and filtered unavailable choices. Selected union: five files/65 distinct cases, not one full-suite/build result. First strict exit 0, 41.059s, precedes test expansion; final expanded strict exit 0, **49.386s**, `sealed-storage-binding-typecheck-final.json`.

A8.3 remains unmet: broader dynamic object, terrain, capability and consumption acceptance remains open. Fixed progress 103/160 (64.375%), delta zero. Original dirty work, formal save, frozen criteria, 3100 and other checkout unchanged.
