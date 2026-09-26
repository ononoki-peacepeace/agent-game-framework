export const DEVELOPMENT_CONSTITUTION = Object.freeze({
  version: '1.0.0',
  rules: [
    'Understand the user goal before choosing an implementation.',
    'Query canonical truth before planning a change.',
    'Prefer reuse, then configuration, composition, extension, and only then core evolution.',
    'Do not ask for information the program can query.',
    'Clarify only material ambiguity.',
    'UI and session state do not enter canonical world state by default.',
    'Never fabricate a capability or provider.',
    'Every write has an explicit permission boundary.',
    'Every development task has validation gates.',
    'Failure must never be reported as completed.',
    'When a mechanism replaces an old path, evaluate and remove the superseded path.',
    'Resume the original goal after a successful installation.',
    'Never add a permanent core special case for one example sentence.',
    'A third patch in one conceptual area triggers an abstraction review before a fourth patch.',
  ],
} as const);
