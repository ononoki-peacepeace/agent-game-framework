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
