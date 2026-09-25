# v0.1.10 — Dialogue Portraits + Character Focus

## What changed

- Structured dialogue now renders as a speaker card with avatar, name and dialogue text.
- Clicking a speaker avatar/name opens that character in the right sidebar.
- Character-list avatars and names can also open the same detail view.
- The character detail view shows known role/location/description, relationship dimensions when available, Character Card context, avatar controls, and a full-body image area.
- Added a generic local `visual_assets.images` map. The UI currently uses the `fullbody` slot, but the save-side structure is not limited to one future visual type.
- Full-body images are local files under `data/assets/visuals`; they are not sent to AI, included in Save JSON, or intended for Git.

## Compatibility

Existing saves remain valid. Avatar storage and `identity.avatar_id` are unchanged. The new `visual_assets` component is created only when a visual image is uploaded.
