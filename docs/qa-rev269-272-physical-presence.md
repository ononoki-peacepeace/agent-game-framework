# REV 269–272: physical resolution and scene presence evidence

Read-only evidence from the formal save's retained `turn_audit` and `data/logs/game-2026-10-16.log`.
No formal turn was submitted or replayed during this investigation.

## Attack: REV 269 → 270

- Trace: `tr_1b00b864626f`.
- HTTP request: `146e027c-6f46-453d-9208-c4e3a999aeef`.
- Core action/receipt: `64bfc6c5-3327-470d-abce-52fb2adade5c`.
- Check: `check_56efdd8a51f86d02acf51335`, `OPPOSED_CHECK`, `classic_d20`.
- Actor domain `physique`, target opposition domain `agility`; both canonical modifiers were zero.
  Neither character had an authoritative attribute/skill value in these domains.
- RNG: player **4**, target **14**; margin **−10**, result `critical_failure`.
- The proposal carried stages `seize_head:normal` and `force_contact:hard`, but the old opposed resolver
  performed one pair of rolls and ignored its stages and difficulty band.
- No distance, surprise, alertness, body-condition or environmental modifier was recorded.
- Committed receipt effects: **time only**, one minute. No injury, control, NPC movement or memory consequence.
- One normal Narrator attempt returned the displayed approximately 200-character prose. There is no evidence
  that a fallback forced the attack to fail. The original failed roll was authoritative; the omitted mechanics
  and consequences are framework gaps.
- The player later reverted this turn at **REV 271**. Its evidence survives in `turn_audit`; it is not an active
  injury or hostility record in the current world, and must not be silently restored.

## Miyake's alleged departure

REV 267 receipt `5b418814-2ec6-4ea2-81c9-abdc6ced3dbf` was a deterministic perception/activity attempt,
not an NPC MOVE. Its own stakes said no person's position was changed. Nevertheless, Narrator described Miyake
crossing the threshold and footsteps receding. REV 269 reused this as prior scene history.
Canonical player, Hayase and Miyake locations were all `boiler`; Miyake had no matching departure MOVE.
The scene list correctly reflected the save. The narrative and subsequent dialogue adopted an uncommitted premise.

## REV 272's unavailable-target message

- `508e4aa7-dc77-4b6a-acc0-f4570f26b6ac`, trace `tr_35f4172c1958`: the eight-character request addressed to Hayase
  used `npc_interaction`, selected `n_hayase`, entered Natural Scene and committed REV 272 successfully.
- `40220b70-15de-4b6c-b162-6295879ce808`, trace `tr_e67514af4221`: a **different, later 49-character request**, also
  targeting `n_hayase`, was classified `world_transaction`. It did not change revision.
- The executor assigned a scene partner only for `natural_scene`, then incorrectly treated `partner === null`
  for any `npc_interaction` request as absence. This produced the unavailable-target message despite valid locations.
- The original 49-character text was not retained in a committed history entry, so its exact wording cannot be
  reconstructed from these logs. Its request identity, lane and explicit target are recorded.
- No evidence ties the error to an out-of-order response or to the successful turn-around request.

## Repair boundaries

Existing stages, Core receipts, condition state, NPC cognition, bounded NPC decisions and activity plans are reused.
No individual character's attributes or historical results are changed. Unknown distance or attention stays neutral;
the player's word “suddenly” alone is insufficient for an authoritative surprise bonus.
Physical damage uses configurable world rules with conservative framework defaults; this is not an anatomical simulator.
Presence validation and the interaction target check consume canonical locations, and prior narration cannot move NPCs.
