# Narrative & Roleplay Foundation

## Architecture reconciliation

This document records the repository audit performed before adding narrative state. It is the boundary contract for the subsystem, not a second design source.

| Proposed semantic concept | Existing authoritative candidate | Decision | Boundary |
| --- | --- | --- | --- |
| World premise and creation choices | `definition.meta`, `definition.world`, `definition.provenance` | REFERENCE | Narrative code reads these fields and never copies the premise. |
| Hidden world truth / secret bible | `definition.gm_state` at world creation and live `save.gm_state` | EXTEND | Structured truth commitments live inside the existing private canonical state. They never enter `PublicView`. |
| Canonical event history | `turn_history`, `turn_checkpoint`, `action_facts`, `event_state` | REFERENCE | Arcs, setups and saga records contain bounded reference ids; they do not copy the history. |
| Recent prose continuity | `narrative_history`, `last_turn` | REUSE | This remains a bounded narration cache and is never treated as world truth. |
| Character identity, age and health | canonical entity components | REFERENCE | Life profile stores only horizon policy and the player entity reference, never a second current age or injury state. |
| NPC goals, knowledge and relationships | canonical entity components and module projections | REFERENCE | Director context receives only relevant projections; it cannot maintain substitute NPC truth. |
| World action planning | agent `GoalSpec`, affordance planner and executor | SEPARATE | This executes player goals. It is not reused for story focus or soft beats. |
| Development `ChangePlan` | change/development subsystem | SEPARATE | It changes framework capabilities and has no narrative meaning. |
| Roleplay constitution | prompt profile prose and scattered narrator rules | EXTEND | A versioned structured framework policy is compiled once into role-specific prompt fragments. World packages may choose bounded modes. |
| Life horizon | no authoritative equivalent | NEW | Optional versioned narrative configuration, expressed as a soft range/reference and never a death date. |
| Saga / major arc / open-loop organization | no persistent equivalent | NEW | Optional `narrative_state` in the same save transaction. It references canonical events and truth ids. |
| Narrative Director | no equivalent; narrator only renders a resolved turn | NEW / SEPARATE | A trigger-driven organizer emits validated soft directives. It cannot patch world truth or action outcomes. |
| Story/life record UI | world history and quest panels are adjacent but not equivalent | NEW | A lightweight framework panel exposes player-safe saga and life records only. |

## Persistence and authority

`SavePackage` remains the only persisted aggregate. Structured hidden truths extend `gm_state`; story organization lives in optional, versioned `narrative_state`. Both are included in the existing world image, revision, checkpoint, restore, import and export path. A v0.1.16 save without either field parses normally and is lazily initialized when narrative behavior needs it.

The definition copy contains the initial private truth commitments. The live `save.gm_state` is authoritative after play begins. Undo restores both truth and narrative organization from the same before-image. A player investigation can add a discovery reference or change an arc, but it cannot replace an existing `HARD_TRUTH` or contradict a `SEEDED_TRUTH` commitment.

## Prompt and agent boundaries

- The framework compiles one structured roleplay constitution into small role-specific fragments.
- The world initializer receives creation policy and, where the premise contains a core mystery, produces bounded truth commitments before play.
- The narrator receives public state, resolved facts, a player-agency fragment and only player-visible narrative context. It does not receive hidden truth.
- GM reasoning can receive the minimum relevant private facts for adjudication, but freeform action adjudication keeps its existing public-only boundary.
- The Narrative Director receives a budgeted context containing relevant truth ids, current saga/arcs, event references and NPC references. It produces soft directives, never prose or world patches.
- NPC and world planners remain independent and do not receive the complete Director plan.

## Unified terminology

| Canonical term | Player-facing Chinese | Developer-facing meaning |
| --- | --- | --- |
| Life | 人生 | One player-character lifetime within a continuing world |
| Life Horizon | 人生长度参考 | Soft pacing range or open-ended/immortal mode |
| Saga | 篇章 | A complete large story phase within a life |
| Major Arc | 主要故事线 | A principal causal line inside a saga |
| Emerging Arc | 正在形成的故事 | A real development not yet given primary focus |
| Dormant Arc | 暂时搁置 | An unfocused arc whose world consequences continue |
| Open Loop | 未收束事项 | A bounded unresolved setup, question or consequence |
| Hidden Truth | 幕后真相 | Private canonical commitment in `gm_state` |

## Compatibility rule

All narrative additions are optional and versioned. Loading an old save does not invent mysteries, NPCs, arcs or a plot. Lazy initialization creates only policy and an empty organization state. The semantically blank world remains blank.
