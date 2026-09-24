## Summary

- Explain the user-visible or maintainer-facing change.

## Verification

- List the commands or checks you ran.

## Screenshots

- **Required when the PR changes rendered UI** — files under `public/` (web
  frontend / manager dashboard) or the Electron rendered surface
  (`electron/src/preload/`, `*.html`/`*.css`/`*.tsx`/`*.jsx` under `electron/`).
  The `screenshot-gate` check fails otherwise.
- Embed the image in this description: `![alt](url)` or `<img src="...">`.
  Dragging an image into the editor is enough; a plain link does not count.
- **Never commit screenshot files to the PR branch.** CLI/agent uploads go to
  the orphan `pr-assets` branch, linked by commit SHA:

  ```text
  https://raw.githubusercontent.com/lidge-jun/cli-jaw/<sha>/<pr-or-date-slug>/<name>.png
  ```

- A maintainer can waive the requirement with the `ui-screenshot-waived`
  label or a comment stating the change does not touch the UI.

## Checklist

- [ ] Scope stays focused and avoids unrelated cleanup.
- [ ] Docs or release notes were updated when needed.
- [ ] Security-sensitive changes were reviewed for secrets, auth, and unsafe defaults.
