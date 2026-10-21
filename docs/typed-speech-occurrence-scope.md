# Typed speech occurrence scope

Parent `afa94ad`. Actual offline baseline: **7 failures / 5 legal controls passed, 3.483s** (`typed-speech-occurrence-scope-baseline.json`). One structured NPC utterance globally removes every identical quoted string from mechanical validation. A subsequent emphasized player pickup can therefore be accepted despite an INSPECT receipt without inventory effects. Four quote styles, mixed styles, repeated typed speech and an actual temporary JsonStore case reproduce the flaw. Core entities remain unchanged but the uncommitted action is accepted as normal prose after one narration/audit.

N4.1 was withdrawn during reproduction: **102/160 (63.75%)**, change -1 condition / -0.625 percentage points.

The repair masks only the ordered, quoted occurrence anchored by each typed speech event. Equal-length spaces preserve diagnostic positions; every other occurrence remains subject to authoritative mechanical validation. Review also found that an unknown opening character and an end-of-string character could both map to `undefined`; explicit quote membership and two unquoted end-of-sentence controls prevent that new regression. No Core effects, NPC reactions or world results are added.

Actual verification (reports under `.agent-runtime/codex/`):

- Baseline: 7 failed / 5 passed, 3.483s, retained.
- Initial repair: 6 files / 66 passed, 16.571s; strict TypeScript exit 0, 32.610s. This precedes the explicit quote-membership guard.
- Final repair including that guard: **6 files / 68 passed / zero failed or skipped, 12.665s**, `typed-speech-occurrence-scope-final.json`. Four quote styles, mixed styles, repeated typed events, unquoted tails, legal non-action controls and actual temporary JsonStore settlement/replay are covered. Disk cases retain entities, one INSPECT receipt and minute; fresh-service replay preserves exact response/save bytes without extra model calls.
- Final strict TypeScript: exit 0, **27.806s**, `typed-speech-occurrence-scope-final-typecheck.json`.

Restore N4.1 only: **103/160 (64.375%)**, +1 condition / +0.625 percentage points from withdrawal, net zero for the whole batch. N4.3 and the broad three-world corpus remain open. No new full suite or build is claimed. Original six dirty files, formal save, frozen criteria and port 3100 are preserved. Next: reproduce remaining arrival-scene failure classification/recovery against actual commit evidence, then continue the original Goal.
