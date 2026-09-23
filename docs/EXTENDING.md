# Extending the framework

Use these existing, executable examples rather than introducing a plugin framework.

## Component

Read [inventory.ts](../src/modules/inventory.ts): item and inventory are ComponentSpec entries with Zod schemas and public projection functions. Register another component in a module's components object. Read/write it through EntityStore.component/update, then enforce cross-entity invariants in module.validate.

No project function means the component data is excluded from ordinary public projection. A projection is a data-permission decision, not just formatting.

## Module

Read [modules/index.ts](../src/modules/index.ts) and the Module interface in [registry.ts](../src/core/registry.ts). Add a trusted module to availableModules, declare requires/version, then enable it in a World Package. Missing dependencies and incompatible versions fail validation.

The test named **adds Company component, action and hook without dispatcher edits** in [core.test.ts](../tests/core.test.ts) registers a company component, HIRE action and completion hook without changing Dispatcher. It is a small extension test, not a production employment/ownership system.

## Action and event

[Commerce](../src/modules/commerce.ts) registers BUY/SELL parameter schemas and handlers. It validates target/item/location/funds and changes both parties' balances and stock in the candidate state. [Routine](../src/modules/routine.ts) demonstrates time advancement and on_interrupt handling.

ActionSpec.ui describes label, visibility (internal/text/contextual/panel), target component and optional text parameter. IntentInterpreter builds its action catalog from registrations. A new mechanical action needs validation and tests, not only a prompt instruction.

## Panel

[Panel registry](../src/client/panels.tsx) maps module panel IDs to React components accepting PanelProps. Follow InventoryPanel or EquipmentPanel, then provide matching panels metadata from the module. App renders registered, enabled panels. Do not introduce runtime loading of arbitrary JavaScript.

## AI provider

[AIAdapter](../src/ai/contracts.ts) exposes name and generate(AIRequest): Promise<AIResult>. Follow [OpenAIAdapter](../src/ai/openai.ts) or [ResponsesCompatibleAdapter](../src/ai/responses-compatible.ts); injected fetch makes transport behavior testable without a real key.

For UI selection, update providerConfigSchema, descriptors and AIProviderManager.make in [providers.ts](../src/ai/providers.ts). Add role-output validation and failure tests; never put API keys into Save, public info or storage. Provider-specific continuation IDs are optional cache metadata.

## Prompt Profile

Copy [default.json](../content/profiles/default.json), retain the real profile fields and version it. Import a profile through the launcher or select PROMPT_PROFILE_PATH for new AI worlds. Existing saves retain their embedded profile.

New AI patches require an explicit role output schema **and** a module authorization handler. The existing relationship_delta path in [relationships.ts](../src/modules/relationships.ts) and applyPatches in [runtime.ts](../src/core/runtime.ts) show both boundaries. Do not bypass them with arbitrary object merging.
