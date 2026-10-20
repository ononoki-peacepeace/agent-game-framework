# Explicit joint NPC subjects retain presence validation

Parent checkpoint: `b52a6e5`. The original presence guard set its subject to unknown whenever a sentence named more than one NPC. Clauses such as “林舟和米拉一起走出了房间” therefore bypassed factual checks even when both authoritative locations were unchanged. The real GameService WAIT path published that invented departure as normal prose.

The baseline is 7 failures and 6 legal controls in `tests/scene-presence-groups.test.ts`. N4.1 was explicitly withdrawn in the fixed ledger before repair; this is an original-scope defect, not new acceptance scope.

The bounded repair recognizes a literal joined NPC name list followed by an existing presence/travel predicate. Each member must satisfy the authoritative location check. It retains singular subjects, clause splitting for independently named subjects or the player, and existing occurrence-scoped denials, intentions, local steps and quoted wishes. A possessor or another person's colleague does not become a joint subject. Identity punctuation is escaped before matching. The helper only validates prose: it cannot move an NPC, generate a reaction, change a receipt or establish that an absent character really traveled.

Final evidence: 8 files, 94/94 passed, including the expanded 15-case group file and neighboring negation, independent-subject, physical, perception and degradation tests. The real service rejects all three unsupported Narrator candidates, renders a grounded degraded WAIT result, preserves both NPC locations, and replay adds neither a minute nor another model call. Complete isolated build is recorded in the local SESSION.

N4.1 is restored only after verification, for net zero score change. N4.3/N4.4 remain open: arbitrary grammar, ambiguous identities, object/subject attribution, multi-world breadth and real-model/human acceptance are not established by this bounded matcher. Latest complete offline snapshot remains product `1bad19e` (207 files, 2064 tests), before later edits.
