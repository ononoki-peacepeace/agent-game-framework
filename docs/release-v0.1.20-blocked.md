# v0.1.20 initial publication hold and subsequent review (2026-10-21)

**Superseded status:** after the initial hold below, the repository owner explicitly authorized a reviewed low-risk exception for ordinary local paths already in public history. Full-document review found an ordinary local attachment path, not a credential, attachment contents or personal record. GitHub's public object/commit API and fetched integration ancestry confirmed prior public availability. The initial classification as sensitive data was too broad. The current document remains sanitized; `public-audit-exceptions.json` records only the exact historical home-path object. Credentials and other findings cannot use this exception. No history rewrite or force push is permitted. Publication verification resumed; see [final release evidence](releases/v0.1.20.md). The following sections retain the initial failure history and checks as they stood at the hold.

No main push, tag creation or Release publication was attempted. Version metadata remains 0.1.19. The proposed patch version is reserved only by this document, not by a Git tag.

## Candidate and remote state

- Development checkpoint: `96133cc1d862bc62606a482be7991b7b986b9111` on `codex/claude-takeover-integration`.
- Fetched public main: `6005f1707bf70e51937f55c34876684f92c05b79`.
- Fetched public development branch: `490c42380dddf80d214061c4ed0c1586bccaa631`.
- Both remote commits are ancestors of the candidate. Latest published Release remains v0.1.19.
- Isolated preparation branch: `codex/release-v0.1.20`. Original checkout, six dirty files, production save and port 3100 are preserved.

## Actual privacy blocker

The candidate's reachable history contains a real local Windows user directory and Codex attachment location in `docs/qa-integrated-world-recovery-checkpoint-2026-10-18.md`, introduced by `797ff6a`. Values are intentionally omitted here. Blob ID: `9b2f8bb18a18af1b197abbbf02287e7a4ec8e857`.

The object is reachable from the fetched public development branch, but not from fetched main. No credential pattern was detected by this bounded heuristic scan; that is not a comprehensive manual privacy certification. The current document is sanitized in this preparation branch. A normal merge still publishes its unsanitized ancestor. Therefore that edit alone does not clear the gate. No history rewrite, force push or silent allowlist was performed. A human decision on the already-public historical path is required before choosing a publication strategy compatible with the user's safety requirements.

## Audit repair and evidence

`scripts/audit-public.mjs` now streams Git metadata and size-framed `cat-file --batch` bodies instead of buffering blobs through execFileSync. It scans binary bodies too, uses a bounded 64 KiB overlap, reports scope and never prints matched secret values. Default scope retains working files and all local objects. `--revision REV` explicitly covers a publication tree, deleted historical paths and all reachable objects; unrelated dirty and unreachable local objects are excluded from that named scope because normal push does not publish them. Heuristic matching still cannot certify arbitrary secrets or tokens longer than the overlap.

Actual candidate scan at 96133cc: 871 tree files, 2,133 blobs, 70,982,073 bytes, largest blob 292,089 bytes; 6.113 seconds, exit 1, one home-path finding. This is a failed publication gate, not a clean audit.

Regression evidence: initial four audit cases passed in 8.21 seconds; final five cases passed in 9.11 seconds. Cases cover a binary historical blob larger than 32 MiB under a 48 MiB JS heap, chunk-boundary credential detection without value output, explicit reachable scope versus dirty/unreachable local objects, invalid revision failure, and a deleted private path still in history. Temporary repositories only; production data is never copied.

## Other actual checks and unexecuted gates

- `provider-schema`, `npc-schema-contract`, `world-creation`: 3 files, 71 passed, 18.40 seconds, offline. This did not reproduce the cloud report; its exact failing test/output has not been matched, so it is not declared resolved.
- TypeScript `tsc --noEmit`: exit 0, 46.641 seconds after adding audit regressions.
- Final `git diff --check`: clean.
- Full isolated build and browser smoke were not run in this publication batch after discovery of the privacy blocker. The reported old-title timeout has not been reproduced or resolved. Prior development builds are historical evidence, not this release gate.
- Test-generated `docs/qa-npc-schema-contract-audit.json` in the isolated checkout is excluded from the source checkpoint. The original checkout's differently dirty copy is untouched.

Fixed acceptance remains **109/160 (68.125%)**, 22 unmet and 29 unverified; net zero. No frozen definition or evidence score changed. In particular A8.3, R5.3, R7.4 and the long-prose quality boundary remain open; no claim of complete acceptance or complete current offline regression is made.

## Recovery

Keep the isolated branch and worktree. Resolve historical privacy policy first; do not push or rewrite it automatically. Then match the reported Schema failure and browser timeout, complete isolated build and necessary regressions, review current content manually, update version/notes, repeat reachable audit and remote ancestry checks, and only then publish main/tag/Release. Preserve original dirty files. The ongoing four-theme Goal is not completed by this blocked publication checkpoint.
