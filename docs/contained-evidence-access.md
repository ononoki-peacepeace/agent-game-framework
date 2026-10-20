# Sealed container ancestors bound evidence discovery

Parent `9acea32`, product `8b5d2df`. A general scene inspection could discover an anchored clue inside a sealed scene container or a sealed container in the actor's inventory. The old accessibility check used only anchor room/holder, ignoring containment. On a successful actual Core inspection, narration refusal then exposed the contained clue in grounded fallback prose. N4.1 was withdrawn before repair.

The initial uncontrolled-RNG baseline had 4 failures/4 passes; its narration case happened not to discover the clue. With a fixed successful RNG, the same legal validated fixtures give 5 failures/3 lawful controls. Both reports remain preserved. The scenario/source hash manifest was captured before the product repair.

Evidence accessibility now walks the scene `item.container_id` chain or the holder's `inventory.placements` chain and excludes a clue behind a sealed ancestor. Missing/cyclic ancestry also cannot grant access. The anchor itself may be a sealed container: exterior evidence remains discoverable. Open-container discovery, previous knowledge and evidence destruction/transfer semantics remain intact. No container is automatically opened, no historical knowledge is erased, and no schema, receipt/commit semantics, time or model budget changes.

Focused coverage includes direct/nested scene and held containment, open-container and exterior controls, an NPC observer, explicit evidence-ID bypass refusal, preservation of previously discovered information, actual Core INSPECT plus refusal/content-filter fallback, and real JsonStore/new-service request replay. The disk case preserves bytes and performs zero generation on replay. It is service recreation, not a new HTTP test.

Final adjacent regression/build counts are in the checkpoint handoff and SESSION; raw `contained-evidence-*` reports remain in the ignored takeover checkpoint directory. N4.1 withdrawal/restoration is net zero, returning to 60% (96/160). Broader N6.3 container/environment/temporary-item/transfer/consumption coverage stays open. The latest complete offline snapshot is still product `8b5d2df` at 222 files/2192 assertions; this later repair has targeted evidence. Formal save, original uncommitted files, frozen definitions and production/paid-provider/Claude boundaries are preserved.

The first build identified that generic component JSON does not statically guarantee a string `container_id`. The scene-parent selector now validates that type explicitly; the failed build log is retained separately from the final build.
