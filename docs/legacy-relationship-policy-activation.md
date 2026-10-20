# Explicit prospective activation of legacy relationship policies

Parent `fd17c6a`, preceding product `d1721f4`. This implements the bounded offline activation path proposed in [the legacy policy strategy](legacy-social-policy-strategy.md). It does not select policies for the formal world. The preflight used a constructed legacy world: after a raw policy edit, replaying a retained old unmarked TALK receipt created new numeric relationships. Its full before/after and original source hashes remain in ignored `legacy-policy-activation-preflight.json`.

`previewLegacyRelationshipPolicies(save, policies)` requires explicit author data and an enabled relationship module. It accepts only existing dimensions in a world whose dimensions all lack event policies, reusing the current delta schema. It rejects unknown marker versions, unknown dimensions and invalid values. The returned review artifact contains game/revision, a SHA256 of the normalized JSON source image, selected policies and exact old receipt IDs to mark; it contains no source-world prose or copy of the save. Preview does not mutate the source or run an action/model.

`activateLegacyRelationshipPolicies(service, request, preview)` is an optional internal API. It has no CLI, HTTP route, model tool registration or load-time hook. It rechecks request identity, source image hash and the complete regenerated preview under the existing `agentTransaction` lock, then applies policy changes and old eligible receipt `v1` markers in the same existing one-image transaction. It never recomputes numeric history, creates missing receipts or changes existing markers. A preexisting policy is rejected, not silently replaced. Omitting a dimension preserves its lack of policy; omitting an event has the existing consumer meaning, including harmed→conflict fallback and explicit zero. New actions alone receive the new deltas.

The additive `relationshipReceiptKind` eligibility helper is shared with existing settlement. Existing settlement still validates the caller/action/receipt identity. Preview reads actual typed physical outcomes because physical receipt `semantic_action` can be the original sentence. Integrate `npc-relations.ts` and the new `relationship-policy.ts` together; no save/receipt schema, commit semantics, provider budget or service signature changes are required.

The 20 fixed focused cases cover the following strategy matrix. Counts alone are not acceptance: each row maps to state/receipt/disk assertions in `tests/legacy-relationship-policy.test.ts`.

| Boundary | Verified result |
|---|---|
| Legacy read/restart/TALK/physical | No inferred policy or numeric social delta. |
| Pure preview | Source unchanged; only chosen policy and old IDs; private note absent. |
| Activation | Only policies and old markers change in world image; numeric relationships, resources, time, cognition and plan cursors remain equal. |
| Old unmarked speech/physical receipts | Marked at activation; replay cannot apply new deltas to history. |
| Existing markers/unrelated receipts | Existing `v1` marker arrays preserved; unrelated receipts not added to the list. |
| New contact/physical receipt | Actual new Core result applies once, both directions; duplicate settlement unchanged. |
| Bounds and omissions | Both numeric bounds clamp; harmed fallback and explicit zero remain distinct. |
| Invalid author data/identity | Empty selection, unknown dimension/field/version, out-of-range delta, preexisting policy, game/revision mismatch, tampered preview and stale same-revision hash stop without a write. |
| Competing actual revision | A later existing transaction makes the old preview fail without undoing that edit. |
| Prepare journal failure | No world write before the existing parent intent can persist. |
| Before/after current-image write failure | Actual JsonStore/service recreation yields exactly one successful activation; old receipts remain inert, duplicate request preserves disk bytes, zero generation. |
| Undo and replay | Policy and markers revert with the world; original activation request remains read-only. |

Final regression: 6 files, 76/76 tests, zero skips, including existing NPC relationships/repetition, own-resource context, storage and real temporary-HTTP terminal recovery. Final isolated build evidence is in the handoff/SESSION. Initial 23pass/1fail exposed synchronous validation on a promise API; the API now rejects consistently. Expanded 41pass/35fail preserved 2 physical-eligibility failures and 33 sandbox loopback connection failures. The typed eligibility fix and unchanged HTTP tests rerun with temporary loopback access all passed. No failing report was overwritten.

W9.3's offline missing/enabled/migration matrix is now reviewable at this source. W9.4 remains unverified: the human must still select policies and authorize any formal mutation, or explicitly choose legacy preservation. No formal save was copied or edited; no policy was selected on the human's behalf. The latest complete 228-file/2252-test snapshot belongs to preceding `80f9084`; this source has targeted evidence. Native `0xC0000409`, other open themes, cross-process acceptance, deployment and real-provider/human gates remain open.
