# Local step wording is not a scene departure

Parent `0c42587`. Actual baseline `scene-presence-local-steps-baseline.json`: **5 failures/6 controls, 4.924s**. The presence guard accepted numeric “走了两步” but treated “走了几步/数步/半步/一小步” as departed. One actual WAIT therefore discarded lawful candidate prose and degraded after retries.

The existing local-step exception now includes those bounded Chinese step forms. Every later departure occurrence is still scanned; “走了几步，随后离开” and equivalent contrasting/joined clauses still fail. The change classifies narration only and neither moves entities nor establishes NPC actions or new world results.

Actual `.agent-runtime/codex/` verification: `scene-presence-local-steps-fixed.json` **5 files, 64 passed/1 HTTP fetch failure, 25.630s**. All 11 new direct/service cases pass; ordinary WAIT retains exact supplied text in normal presentation, one generation, one settled receipt/time increment, exact response replay and unchanged NPC canonical location. Existing negation, joint subjects and movement-authority cases retain their expectations. Only affected HTTP/disk MOVE replay test rerun with temporary-loopback permission: `scene-presence-local-steps-http-recheck.json` **1 passed/9 excluded, 9.092s**. Original failed report retained. Selected union: five files/65 distinct passes, not one complete green suite.

Strict TypeScript exit 0, **68.187s**, `scene-presence-local-steps-typecheck.json`. No full build rerun. This is a bounded expansion under already-unmet N4.3; arbitrary metaphor, retelling and full multi-world lawful/unsafe expression matrix remain open. 103/160 (64.375%), delta zero. Formal/frozen/3100/Provider/original dirty work preserved.
