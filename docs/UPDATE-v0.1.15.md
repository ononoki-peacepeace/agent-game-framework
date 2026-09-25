# v0.1.15 hotfix

- Fix routine rollback when `GameService.export()` returns serialized JSON: parse the snapshot before `import()`.
- Keep package/header/health version aligned at 0.1.15.
- Map auto-centers on the current hierarchy after movement; when a save has no parent hierarchy, the default view becomes a local-neighborhood graph instead of flattening every root location into one screen.
- Infer an obvious parent for legacy locations whose names begin with another location name (for example, a school dorm prefixed by the school name). This is UI-only and does not rewrite canonical save geography.
- Character summary lines are formatted for readability. HP/stamina/stress are split into separate lines, stamina/stress show maxima (component max when present, otherwise 100), and phase text splits after the weekday marker.
