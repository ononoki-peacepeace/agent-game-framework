# v0.1 implementation plan

Local Node/TypeScript runtime, React/Vite UI, JSON storage; no hosted services.
The framework is standalone and has no dependency on private prototype files.

1. Strict World/Save envelopes, small registries and module contracts.
2. Atomic actions on cloned canonical saves, bounded event bus, time and injectable dice.
3. Core, characters, relationships, inventory and commerce modules; independent town demo.
4. Atomic JSON persistence, explicit checkpoint/load/export/import and migration entrypoint.
5. Separate initializer/intent/narrator schemas and profile fragments; Codex SDK and Mock.
6. Public projections and module-driven frontend panels; responsive local play surface.
7. Offline invariants/security tests, build, HTTP/browser smoke and optional live Codex smoke.
8. Document evidence, limitations and commit the finished implementation.

Save is authoritative. AI never receives storage handles. Actions own hard rules; AI may
only propose registered intents and explicitly authorized relationship changes. Narration
receives a public projection, preventing hidden canonical facts entering narrator context.
Thread IDs are replaceable per-role cache metadata. Import clears cached thread IDs.
