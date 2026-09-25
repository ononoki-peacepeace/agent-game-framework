# v0.1.12 Mobile LAN hotfix

Fixes two issues seen when opening the game from a phone over plain LAN HTTP:

1. Action submission no longer depends on `crypto.randomUUID()`, which may be unavailable in non-secure HTTP contexts. A standards-shaped UUID v4 fallback is used, so tapping Send works on `http://192.168.x.x:3100`.
2. The voice button now explains the real limitation on insecure LAN HTTP instead of reporting a vague recognition failure. Browser speech recognition/microphone access requires a secure context (HTTPS/localhost); the textarea is focused so the phone keyboard's microphone can be used as the immediate fallback.
3. Failed unified-input requests now retry through the original endpoint (`input` vs `action`) instead of always retrying as an action.
