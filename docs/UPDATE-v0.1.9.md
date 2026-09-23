# v0.1.9 — Compact UI + Provider Persistence

## UI

- Success/info notices are now dismissible toasts and auto-hide after a short delay.
- Error notices remain until dismissed so failures are not lost.
- Removed the large in-world title/time header from the play surface.
- World name, day, time and revision now live in the Status panel.
- The top application bar is smaller and only keeps a compact home mark, provider selector and version.
- Reduced desktop padding so the story and right-side panels start higher and show more content.
- Character Card JSON import remains directly visible at the top of the Characters panel on desktop and mobile.

## AI Provider persistence

- Provider selection may be persisted on the local server.
- Persisted provider configuration is stored under `data/secrets/ai-provider.json` and therefore stays outside canonical saves and Git.
- API keys are never returned to browsers; clients only receive an `api_key_configured` flag.
- Desktop and mobile clients connected to the same server periodically resync the current provider.
- The provider dialog can remove the persisted configuration.

> The local secret file is not an OS credential vault. Protect the machine account and the `data/` directory.

## LAN

- Production LAN mode remains opt-in with `HOST=0.0.0.0`.
- Added `npm run start:lan` as a cross-platform shortcut for the production build.

## Docs

- README is now bilingual (Chinese + English).
