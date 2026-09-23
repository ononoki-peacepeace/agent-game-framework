# Security and privacy

This is a local prototype framework. It binds to loopback and checks request Host/Origin and a local token for mutations. It is not designed to be exposed directly to the internet or to run untrusted modules.

- Keep API keys, Codex authentication, .env, private Prompt Profiles, real saves and uploaded avatars out of Git.
- Full Save exports contain GM-hidden facts and personal history. Use a freshly generated fictional example for reports.
- API providers receive the context sent by the AI runtime. Compatible-provider URLs must be trusted.
- Codex runs with restrictive settings and unexpected tool results are rejected. This is defense in depth, not an OS-isolation guarantee.
- Do not publicly post raw provider errors without checking them for secrets or user information.
- Public-file audit uses heuristics. Review all staged files and history; a passing scan is not a security certification.

If you discover a vulnerability, avoid posting credentials or private data in a public issue. A private reporting channel must be configured when the GitHub repository is created; no maintainer address is invented here.

Before publishing, choose a license, verify Git author identity, inspect the release checklist, and obtain the project owner's explicit authorization for repository creation/push.
