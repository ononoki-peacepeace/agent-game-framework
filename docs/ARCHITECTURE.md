# Architecture · application v0.1.7

## Runtime boundary

```text
Web UI
  ↓
GameService — request IDs, revisions, serialization, checkpoints
  ↓
Action / Module Runtime — canonical handlers, events, time, dice
  ↓
Validated canonical Save — JSON storage

GameService ↔ AI Runtime
                ↓
             AIAdapter
             ├─ Codex
             ├─ OpenAI
             ├─ DeepSeek
             ├─ Responses-compatible
             └─ Mock
```

**AI proposes/interprets; Framework validates and executes; Save state determines reality.**

No provider owns a storage handle. Model output does not merge arbitrarily into state. A provider thread is context cache, not a save. Each request receives the relevant current state; imported saves clear thread metadata.

## Core and modules

[Module contract](../src/core/registry.ts) defines id/version, dependencies, component schemas, action handlers, event handlers, state validators, panel metadata, prompt fragments, and authorized patch operations.

[Module catalog](../src/modules/index.ts) registers core, characters, relationships, inventory, commerce, attributes, aptitudes, skills, traits, equipment, quests, and routine. These are trusted static TypeScript modules, not dynamically installed plugins.

An Entity has a stable id, type and component dictionary. EntityStore offers entity/component/update access; schemas belong to their modules. Component/Action registries feed the Schema Registry. EventBus invokes registered handlers; Dispatcher does not branch on every game-specific action.

Mechanical logic includes route traversal, time, RNG, inventory and funds, equipment references, and bounded relationship updates. Module configuration and World Package data define particular currencies, slots, dimensions and locations.

## World and Save

World Package describes initial content: meta, enabled_modules, ruleset, prompt_profile, world description, initial entities, map, events, player, gm_state, and initial time.

Save Package contains:
- schema_version / framework_version / module_versions;
- game_id and state_revision;
- embedded initial definition and current canonical entities;
- player_state.entity_id and separate gm_state;
- event_state, runtime.time and recent request receipts;
- map_state: known locations, dynamic locations and routes;
- optional role-specific AI thread IDs;
- last_turn, including dialogue and cached scene suggestions.

Derived information should be calculated from canonical data rather than persisted twice. PublicView is computed via module project functions and known-map filtering. It is not a second writable player database.

**Compatibility:** package version 0.1.7 does not change the existing schema_version 1 / framework_version 0.1.0. Existing validation/defaulting, migration entry points and the lazy routine baseline upgrade are retained. This publication pass does not rewrite users' saves.

[JsonStore](../src/storage/json-store.ts) validates and writes via a temporary file, fsync and rename. GameService serializes mutating operations; startup uses a data-directory lock. File persistence is replaceable behind SaveStorage. Stronger multi-process/distributed guarantees are outside this local version.

## Action lifecycle

1. Browser submits one action or free-text input, request_id, game_id and expected_revision.
2. GameService checks deduplication/revision; text is interpreted against the registered action catalog.
3. Runtime clones the save, validates parameters, assigns authoritative actor/source/time cost, then executes the handler.
4. Program time/dice and module/world hooks run against the candidate state.
5. Validators reject illegal states before persistence.
6. Narrator receives public state and executed facts. Only explicitly authorized patches can be applied.
7. Commit increments revision and records the receipt with last_turn. Return the public projection.

Intent failure does not execute an action. Narration failure can degrade to program facts while committing a valid deterministic action; the UI reports this. Reusing a committed request ID prevents repeating the same trade. Import/load creates a new game generation to invalidate stale requests.

## Maps, events and routines

The baseline graph lives in definition.map. Hierarchy metadata supports region/city/district/POI relationships. map_state tracks known locations and controlled dynamic additions. [Map helpers](../src/core/map.ts) provide the current combined graph and reveal/add operations. UI sees only known locations and relevant projected entities; displayed high-level connections do not create executable routes.

World events use registered hooks and bounded data fields, not executable scripts. Probability comes from the program RNG. Dice expressions support NdM and signed modifiers with injectable randomness in tests.

Routine advances discrete chunks, triggers normal time/day/world events, and stops on on_interrupt. It does not invent earnings or XP; corresponding gameplay modules must implement those rules.

## AI runtime and profiles

Separate output schemas exist for WorldInitializer, IntentInterpreter and Narrator. World authoring uses a bounded blueprint, compiles it into a World Package and validates it. Runtime action parameters are validated by their own registered schemas. Contextual suggestions are cached prose intents, not already-executed state transitions.

Prompt Profiles contain id/version and engine_policy, world_initializer, intent_interpreter, narrator, npc_decision, gm_reasoning fragments. NpcDecision/GMDecision remain reserved profile roles. Long policies are supported; current initializer limits differ from the broader World Package schema.

Soft behavior and narrative style belong in profiles. Deterministic time, dice, money, inventory, position, revision and write authorization belong in code. Prompts cannot override canonical facts.

AIAdapter.generate accepts role, prompt, schema and optional threadId/signal. Codex uses local authenticated CLI and role-specific threads. API adapters send structured requests to Responses-style endpoints and are stateless with respect to provider threads. API keys stay outside Save and are not returned in provider info. See [provider contracts](AI_PROVIDERS.md).

## Web and privacy

[API](../src/server/app.ts) supplies session/provider metadata, public state, action/new/save/load/import/export operations, and local avatar upload. Mutations use a local session token; Host/Origin checks and loopback binding limit access. There is no internet account system.

Ordinary state endpoints do not send gm_state, full definition, or thread IDs. Full export intentionally contains private GM data and is a separate backup operation. Trusted profile content and provider error strings still require care before sharing.

Panels use a static React registry and module metadata; absent module panels are not fabricated. Scene interactions are staged in the composer before confirmation. Uploaded avatars live under the private data directory and are not model input. JSON exports contain avatar IDs, not image bytes.

## Scope and risks

No distributed runtime, untrusted code plugin sandbox, complete combat/business simulation or autonomous background NPC scheduler is claimed. Schema validation cannot prove narrative consistency. Codex restrictions and unexpected-tool detection are defense in depth, not pure-inference isolation. Local-only errors may contain upstream provider text; redact reports.

Release preparation modifies documentation, ignores and stale test fixtures, not game rules. See [release evidence](RELEASE_CHECKLIST.md).
