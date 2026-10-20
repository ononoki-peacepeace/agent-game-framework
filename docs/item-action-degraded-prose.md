# Item actions retain their Core facts in degraded prose

Parent `33a99bf`, preceding product `857a42c`. Eight actual service baselines failed: BUY/SELL both became `这次尝试已完成。已登记物品的位置随之更新。`; EQUIP/UNEQUIP both became `这次尝试已完成。`. The item, trade amount and actual action disappeared. Initial reports and source/scenario hashes are retained in ignored `item-action-degraded-prose-*` evidence.

The existing canonical renderer now recognizes only the four built-in deterministic successful action facts. Item, quantity and amount come from the settled receipt's existing Core-generated `canonical_facts`, never from model prose or a later inventory snapshot. Exact known fact formats are required. Hidden results, unsuccessful checks, unknown action types and incomplete facts retain conservative handling. Compound child receipts use the same renderer. No settlement, schema, receipt fields, public interfaces or provider budget changes.

The fixed Chinese outputs were individually reviewed for readability and factual limits (town currency is `点`):

| Action | Reviewed output | Limit |
|---|---|---|
| BUY | 你买下了1件铜戒指，付了10点。 | Actual item/quantity/payment only. |
| SELL | 你卖出了1件铜戒指，收到了5点。 | Actual item/quantity/receipt only; no shopkeeper reaction. |
| EQUIP | 你装备好了铜戒指。 | Actual equip; no invented pose or benefit. |
| UNEQUIP | 你卸下了铜戒指。 | Actual removal; no invented destination. |

Final regression: 7 files, 56/56 tests, zero skips; final isolated build evidence is recorded in the handoff/SESSION. Twelve focused cases include both refusal/content-filter paths for each action, actual ordered BUY→EQUIP compound settlement, actual JsonStore/service recreation preserving saved prose and file bytes with zero generation on replay, hidden/failure/foreign/incomplete controls, and actual stack quantity/zero-price sale. Duplicate requests do not repeat generation or settlement. The initial compound assertion incorrectly expected a child's action type on the aggregate receipt; corrected to inspect the actual two children and aggregate commit status. That 54pass/1fail report remains preserved; no product fix was needed for the fixture assumption.

N8.2/N3.3 full naturalness and failed/unexecuted multi-goal coverage remain open, net zero to 60% (96/160). This is offline developer review, not real-provider/human acceptance or a complete latest suite. The latest complete snapshot remains `8b5d2df`/222 files/2192 tests. Original dirt, formal save, frozen criteria, production service, paid-provider and Claude boundaries remain preserved.
