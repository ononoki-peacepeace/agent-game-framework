# v0.1.16 hotfix

- Restore MapPanel implementation and map styling to the known-good v0.1.11 baseline.
- Fix routine schema mismatch: START keeps its own strict fields; CONTINUE sends only max_minutes and no longer receives START-only chunk_minutes / activities.
- Keep the 24-hour server clamp and rollback guard for routine batches.
- Improve character summary formatting: stamina/stress get /100 when omitted; stage splits after the weekday.
- Align package, UI and health versions at 0.1.16.
