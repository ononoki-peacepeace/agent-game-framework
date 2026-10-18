# Agent architecture

AGENT GAME FRAMEWORK uses its own **Herne Agent Runtime** and persistent world core. It does not use LangChain or LangGraph. The runtime interprets a player goal, selects an existing capability, observes its structured result, refreshes canonical state, and then continues, finishes, or pauses. The game core owns authoritative transitions.

```text
Goal → semantic entry → planner / open goal → Skill Registry
                                           → existing Tool / domain capability
                                           → authoritative Game Core
                                           → canonical world, transaction, receipt, save / undo
                                           → observed result → Narrator
```

Memory and context, validation and guardrails, structured traces, and agent tests cross these layers.

| Term | Boundary |
| --- | --- |
| Function | An internal implementation detail with no Agent facing contract. |
| Tool | An atomic existing operation with declared input, authority, side effect and persistence metadata. The current tool catalog describes operations; their existing owners still execute them. |
| Skill | A reusable high level adapter that invokes existing domain services or core actions. A skill cannot write canonical state outside those services. |
| Agent Runtime | The existing semantic, planning, clarification, retry, continuation and executor flow that chooses and observes skills. |

`src/agent/skills` contains thin adapters. The current executable Skill Catalog is `temporal_wait`, `location_exploration`, `natural_scene`, and `public_world_query`. `temporal_wait` executes one core WAIT action to a resolved target, while the core advances time in bounded internal segments and commits one receipt. `location_exploration` delegates to the existing location search, independent world review and transaction. `natural_scene` delegates to the existing scene proposal and validation; any persistent effect still requires its existing settlement path. `public_world_query` delegates to the existing public-evidence truth query and remains read-only. `npc_expansion` is metadata only: validated background evolution can spawn an NPC, but the project has no safe standalone NPC expansion executor to expose yet. The registry rejects invocation of this metadata only skill.

`ToolCatalog` describes existing `GameService` reads, core `MOVE`/`WAIT` actions, location search, scene proposal and background validation. It checks core action descriptors against the existing module registry. It is not a second transaction dispatcher and grants no model write authority. A future LangGraph or LangChain adapter could consume these skill and tool descriptors without replacing the current runtime.

The registry emits `skill.selected`, `skill.started`, `skill.completed`, `skill.interrupted` and `skill.failed` through the existing trace. Each event carries the skill and request identity, relevant goal, before and after revision and time, outcome, receipt IDs, duration and failure code where applicable. Existing `agent.action_selected` and `save.commit` events show the core operation under the same trace ID. No raw provider response or secret is recorded.

One trace for an admitted standalone wait is therefore: `agent.context_route → semantic.decision → agent.temporal_wait.admission → skill.selected → skill.started → agent.action_selected(WAIT) → save.commit(WAIT) → skill.completed → agent.outcome`. The game core, rather than the skill registry, validates and commits the world state.
