# Initial possessions migration candidate — read-only preview

Source snapshot: `data/current.json`, revision **260**, Day 1 12:48, SHA-256
`2d28e1476e01fd499ea56e87862f0b5a42ceb810fa04b11e400773f5225f5a0e`.
This is a proposal, not an executable migration. The live save may advance independently.

## Observed authoritative state

| Item described in the player biography | Matching item entity | Player inventory | Equipment |
| --- | --- | --- | --- |
| Camera | None | None | None |
| Half roll of film | None | None | None |
| Coat | None | None | None |

Player `pc_asano` has `inventory.items = {}` and no `equipment` component.
The recent retained action receipts contain no matching item movement. This short history does **not** prove
that the player still carries these items after hundreds of turns.

## Candidate diff, subject to current-state review

1. Define three stable, non-stackable item entities with IDs reserved for this player: `pc_asano_camera`,
   `pc_asano_film`, `pc_asano_coat`. Set `owner_id = pc_asano` and `tracking = tracked` only after confirming
   the items have not been lost, transferred, consumed, or otherwise changed during play.
2. Put confirmed currently carried items in `pc_asano.inventory.items` with quantity 1. The original biography
   does **not** say that the film is already loaded, the camera is held, or the coat is currently worn.
   Those placements therefore require separate review; do not silently set `placements.film = camera` or an
   equipment slot from that sentence alone.
3. If later authoritative history proves a transfer or loss, put the item at that recorded owner/location
   instead of recreating it in the player's bag. If the evidence is insufficient, leave that item unresolved.

## Safe commit design

- Require an exact current revision/hash and re-read the save immediately before applying a migration.
- Search all entities, inventories, equipment, scene placements, receipts, and known item IDs again.
- Reject conflicting existing items; if all three item IDs and intended ownership already match, return
  `already_applied` with no new revision.
- Commit all confirmed item records and the matching inventory/equipment changes in one existing world
  transaction and checkpoint. Validate references and capacity before commit; Undo must restore the before image.
- Record a migration ID and a non-secret audit summary. No Narrator text may be used as a substitute for the
  authoritative item state.

No part of this candidate has been applied to the formal save.
