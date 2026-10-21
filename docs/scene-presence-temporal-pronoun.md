# Temporal joined pronouns and canonical scene presence

Parent `6337357`. Actual `scene-presence-temporal-pronoun-baseline.json`: **6 failures / 5 controls, 3.898s**. In “林舟仍在这里。随后他和乔宁离开了这里。”, 林舟 is authoritative at the player's square and 乔宁 is remote. The previous bare-pronoun substitution does not recognize the temporal prefix, so only the remote person is checked and the invented local departure passes. Sentence/comma variants with 随后/随即/接着/然后/这时/同时 reproduce the defect.

N4.1 withdrawn pending repair; N4.3 remains unmet. Original reports retained under `.agent-runtime/codex/`. No NPC moves or reactions may be created to make candidate prose true.

Minimal repair extends the existing unique-antecedent substitution to the six existing temporal connectives, preserving the prefix before the literal joint-subject check. No change is made to route authority, world facts or actual NPC state. Denials, future intentions, local steps and explicitly remote departures remain valid controls.

`scene-presence-temporal-pronoun-fixed.json`: **four files / 51 passed, zero skips, 11.045s**. Includes two actual synthetic JsonStore/service-recreation WAIT cases: the bad candidate is degraded after three bounded Narrator attempts, entities stay byte-equivalent, one minute/WAIT receipt is committed and exact returned view/disk bytes replay without any generation. The prior perception joined-pronoun, speech-tail and independently named subject regressions are included. No live Provider calls. Strict root TypeScript exit 0, **34.815s**, in `scene-presence-temporal-pronoun-typecheck.json`.

N4.1 restored: **103/160 = 64.375%**, +1 from withdrawal / zero net change from parent. N4.3 full lawful/multi-world language corpus remains open. No complete suite/build rerun or claim. Original six dirty files, formal save, 27 frozen files, 3100 and Claude checkout preserved. Continue the original Goal with other fixed acceptance gaps.
