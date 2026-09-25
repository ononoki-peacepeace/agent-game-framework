# v0.1.14 corrected

- Fixed routine `activities` schema mismatch. Natural-language routine text remains in `pattern`; custom routine submissions use `activities: []`; server filters activities to identifier-safe strings only.
- Map no longer uses persisted coordinates inside a hierarchy level. Direct children are arranged in a deterministic grid, with explicit current-level/parent labels and wrapped long names.
- Status and character descriptions render as readable sentence-level rows.
- Version metadata bumped to 0.1.14.
