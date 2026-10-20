# Injury denials retain their explicit subject

On parent `759e9fb`, three legal Core-backed samples failed: Lin was harmed, but the unhurt player or Qiao was explicitly described as uninjured. The physical firewall applied every injury-denial phrase to every harmed target. Five denial/ambiguity controls passed before repair.

The injury-denial check now exempts a clause only when its immediate grammatical subject uniquely identifies another character in the actual Save. It accepts an exact character name or the player aliases “你”/“玩家”, with a bounded set of ordinary intervening adverbs. It does not infer a subject from an object mention, pronoun, joint subject, duplicate name or missing scene. Each actual physical child is still checked against its own target; explicit denial of a second harmed target remains rejected. Repeated-attempt temporal scope and concrete-injury/perception guards are unchanged.

Final 11 files / 108 tests passed; the complete isolated build is recorded in local SESSION. The new eleven-case file includes real Core harm/miss receipts, player/other-person legal prose, comma and sentence boundaries, joint/ambiguous subjects, two actual physical targets, missing scene and duplicate identities. This is a bounded subject repair, not general Chinese coreference or multi-world prose acceptance.

N4.2 evidence is explicitly withdrawn for the counterexample and restored after repair, with net zero. N4.3/N4.4 stay open, and score stays 60.00% (96/160). The complete 195-file / 1957-test snapshot still belongs to `9917459`, before the subsequent source edits. No Core outcomes, NPC decisions, time, resources, Save schema or frozen acceptance are changed.
