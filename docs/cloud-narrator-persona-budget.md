# Narrator persona budget continuation

Base: remote main `7cd0c8a4665831acc0b52faf646ddf9062b2d874`.
Branch: `codex/cloud-narrator-persona-budget`. Independent worktree:
`/workspace/narrator-persona/game`. PR #8 head dc18a72 and PR #9 head 39b60a7
are verified and retained, but neither is a dependency of this delta. GitHub API
metadata reads return Forbidden; no unverified merge state is assumed. Do not
replace Windows integration files wholesale. Frozen ledger remains 109/160.

## Investigation and evidence boundaries

The same greedy persona projection was used for autonomous NPC decisions and
Narrator expression. Long behavior arrays could fill the 1000-character budget
before speech style, social style or emotional tendencies were considered. The
ordinary request still had some profile fields in public state; the expression
repair request only had the reduced persona and could lose those distinctions.
This is a representation defect, not proof of any particular model's dialogue
quality. Fixed authored profiles and response text are labelled as controls.

The proposed change gives Narrator expression an explicit selection priority
within the existing serialized JSON character budget, retaining current personality,
speech, social and emotional context ahead of secondary behavior lists. Existing
NPC decision/travel/scene selection and literal-sample defaults remain unchanged.
No current mood, friendship or action is inferred from personality tendencies.

## Fixed-condition matrix

| Conditions | Existing evidence reused / current work | Still open |
|---|---|---|
| N5.3/N5.4 | Prior paired corpus; reproduce persona loss during repair and protect actor attribution | Actual differentiated voice and authorized real-model review |
| N7.3/N7.4 | PR #9 provenance/selection; existing 72h corpus and real replay tests | Long generated expression and independent continuity review |
| N9.1/N9.2 | Existing 56-case corpus, dimension rubrics and review importer | Unreviewed ratings are not filled by developer controls |
| N9.3/N9.4 | Preserve attributable raw prompts/outputs and source hashes | Full current-model benchmark and independent review |
| N3.4/N8.2/N8.4 | PR #8 physical/fallback repair remains separate | Naturalness of actual current-model/fallback combinations |

## Integration

Target main, not PR #9. Shared overlap with PR #8 is the persona import/call in
`src/ai/narrative-health.ts`; preserve its crowd/target ordering and refusal logic.
Only the new purpose argument is required at the existing call site. Do not
reimplement PR #8/#9, Core action semantics, inventory, NPC decisions or reliability.

## Stage 1 checkpoint

The initial three-world baseline failed 3/3 on omitted social context. Expanded
voice/social controls failed 6/6; the voice variants lose speech_style entirely.
Both reports and raw states remain under `.agent-runtime/codex/persona-*`.
The repaired three-file suite passes 11 tests, including existing character-card
and NPC-dialogue boundaries. The new optional `purpose="narration"` argument is
used only by the Narrator context; default `decision` callers are unchanged.
The 1000-character cap remains, literal dialogue samples remain excluded, and
selection does not assert that every possible long field can always fit.

## Stage 2: repetition belongs to a speaker

Repetition health concatenated narration and dialogue without speaker identity.
Three worlds reproduce an unnecessary second generation when Lin gives the same
answer as Qiao; a short-answer control reproduces the same error through the
`generic_without_context` path. Original baseline: 5 passed / 4 failed, no skips.
The five positive controls already detect same-speaker loops and repeated prose.
Original report/output snapshots are retained as `dialogue-attribution-baseline`
and `dialogue-attribution-before/`.

The quality heuristic now compares dialogue only within the same known voice.
It still compares descriptive narration across speakers, retains two-unattributed-
legacy behavior, and does not assign unattributed history to a known character.
This changes an expression-retry trigger, not a fact validator, dialogue decision,
refusal boundary or authoritative state. It does not guarantee that a same-speaker
repeat is inappropriate in every conversational setting.

The initial affected three-file run passes 41 tests. Expanded stage controls
pass 23 tests, including two legacy-identity boundaries and six actual
JsonStore/GameService commit/reconstruction/exact-replay cases across commerce,
relationships and autonomy. The two NPCs retain separate authored profiles;
normal authored and offline-refusal paths preserve canonical profiles/relationships,
advance time/revision once and preserve exact save bytes on replay. No uncontrolled
NPC decision, paid Provider or generated-quality rating is used.

## Observed PR #9 compatibility preview

A non-ref-updating `git merge-tree --write-tree 39b60a7 72eff6f` preview reports
conflicts in `CLAUDE-HANDOFF.md` and `src/ai/narrative-health.ts`. No branch was
merged or moved. Product conflict is confined to the adjacent persona call and
PR #8's `location_id`/`present` addition. Resolve by retaining that complete
location/presence line and using:

```ts
allowed_persona:composePersonaContext(save,e.id,1000,false,'narration')?.fields??{},
```

Retain PR #8's target-first crowd ordering and `assertNotRefusal` implementation;
the speaker-aware `narrativeHealth` changes below them merge independently.
Retain both handoff appendices. Preview output is preserved in
`persona-pr9-merge-preview.txt`. This static preview is not a tested integration
with Windows' current local edits; final combined regression remains required.

## Final verification and delivery boundary

Tested source: `72eff6fcdeb08addd5206536658866696f4b089e`.
16 affected files / 107 tests passed, zero failed/skipped. Strict root TypeScript,
Vite frontend and server TypeScript build exit 0. All 654 pinned source/config/
fixture/criteria inputs unchanged. Existing bundler annotation/chunk-size warnings
remain. This is scoped regression, not a full-project or complete current-model
benchmark result.

Evidence archive: `/workspace/scratch/narrator-persona-budget-72eff6f.zip`,
3,303,770 bytes; SHA-256
`69823116d0e3aaef57eb4258cbca9191c260f0ef13fd26905a0505d109e40c84`.
ZIP integrity checked. It contains original failures, before/after states,
requests/outputs, real save bytes from isolated fixtures, final source hashes,
baseline product source, cumulative delta and merge-preview diagnostics. No
credentials or formal game saves are included.

Actual controlled output examples, identical across the three different structures:
- Different-speaker answer: “那天我没有去车站，也没有看见公告上的变化。”
  remains attributed to Lin; one generation instead of two. This is supplied
  offline text, not a claim that a current model naturally said it.
- Ordinary authored WAIT: “你等了一分钟。”
- Actual offline fallback WAIT: “你等了1分钟。”
  Both commit exactly one revision/minute; replay adds no generation or byte change.

Fact/state assertions pass in these fixed cases. Specificity, coherence, voice,
naturalness and long narrative quality remain unscored; no lexical assertion is
substituted for those judgments. The existing 56-case rubric/review infrastructure
is reused, not replaced by these controls. No new actual-model corpus or independent
ratings were produced. Current-source full model/quality capture remains external.

Next checkpoint: Windows reviews the documented shared-file conflict, runs
combined regression with its integration, and uses authorized current-model paired
voice/recall samples plus independent quality review. Selection remains bounded;
not every overlong persona fits, and repeated dialogue can still be legitimate
within one voice. No further reproduced failure remains in this declared suite.
The long Goal and all unreviewed frozen quality conditions remain open; 109/160
is unchanged. No production deployment, Release, paid call or main merge occurred.

Delivery: `codex/cloud-narrator-persona-budget` pushed successfully (verification
handoff b9bf78b). Draft creation with `gh pr create --draft --base main --head
codex/cloud-narrator-persona-budget` returned GitHub GraphQL Forbidden. No PR
creation is claimed. Correct main-base comparison, select Draft in the UI:
https://github.com/ononoki-peacepeace/agent-game-framework/compare/main...codex/cloud-narrator-persona-budget?expand=1
The existing PR #8/#9 branch heads are unchanged. Worktree retained for recovery.
