# Equipped-item sale prerequisite

Parent `90ff29f`, preceding product `132de1c`. Selling a legally equipped item reached final save validation with an equipment slot referencing an absent inventory item. Baseline: 2 failures/1 explicit-UNEQUIP control; actual error was `已装备物品不在背包中`, including through GameService. Reports/source hashes remain in ignored `equipped-item-sale-*` evidence.

SELL now refuses an item referenced by the seller's equipment slots using the existing structured world-unavailable result, before payment/inventory/time effects. The player must explicitly UNEQUIP first; no automatic slot mutation or invented action is introduced. No schema, Core commit, pricing, BUY or public interface changes.

Final isolated regression: 5 files, 77/77 tests, zero skips; isolated build passed (session 39032). Focused tests verify structured world refusal and all-state equality, successful explicit UNEQUIP followed by actual sale/payment, and actual JsonStore/new-service repeated refusal preserving disk bytes and zero generation. This is service recreation evidence, not HTTP. Full A8.3/N6.3 item/terrain/consumption/multi-world coverage remains open; 60% (96/160), net zero. Complete 222-file/2192-test evidence remains earlier `8b5d2df`. Original dirt and all production/frozen/provider boundaries remain preserved.
