# v0.1.12 Build Fix

Fixes four TypeScript JSX errors introduced by optional `identity.avatar_id`, whose component schema value is typed as `unknown`.

The affected JSX conditions now explicitly coerce `avatar_id` to boolean before rendering:

- `SceneContext` avatar button in `src/client/App.tsx`
- Character detail remove-avatar button in `src/client/panels.tsx`
- Player status remove-avatar button in `src/client/panels.tsx`
- Character card remove-avatar button in `src/client/panels.tsx`

No runtime behavior or save schema is changed. This is a compile-only compatibility fix for v0.1.12.
