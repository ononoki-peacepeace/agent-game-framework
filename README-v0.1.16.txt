Agent Game Framework v0.1.16 hotfix overlay

Fixes:
- Routine START / CONTINUE no longer send or inject schema-invalid chunk_minutes / activities keys.
- Routine batches remain server-clamped to <= 24 hours and retain rollback protection.
- Map implementation and map styling restored exactly to the v0.1.11 baseline that was working before the later layout experiments.
- Character summary keeps readable one-line-per-item formatting.
- Stamina / stress display adds /100 when the legacy summary omitted a maximum.
- Stage text splits after weekday, e.g. '阶段：学院第十二周周三' then '放学后…' on the next line.

After extracting over D:\game, verify package.json shows 0.1.16, then run npm run build && npm start.
