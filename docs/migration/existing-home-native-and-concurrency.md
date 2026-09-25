# Existing-home native ACP and concurrency 20

Existing `settings.json` homes stay on print transport and `multiSession.maxConcurrent: 2` because load pins those old defaults. The next settings load will migrate them.

Tracked in [#761](https://github.com/lidge-ai/cli-jaw/issues/761).

| Surface | After the next load |
| --- | --- |
| `perCli.cursor` / `claude` / `grok` `transport` | `native` once per migration id, when permissions allow (Cursor/Grok: `auto`; Claude: `auto` or `safe`). The current id is `native-transport-default-v2`: homes stamped by v1, including those that picked `print` after it, move to native again on this update. An explicit `print` chosen after the v2 stamp is kept. |
| `multiSession.maxConcurrent` | `20` when the stored value is exactly `2`. Other integers stay. |
| New homes | Same defaults. No Settings banner. Schema stays v4. |

Engines whose permissions cannot run natively (Cursor/Grok outside `auto`, Claude with `custom` permissions) stay print so spawn does not refuse the next run; the v2 stamp records them as `partial` and flips them once permissions later allow. Established homes with no settings file get native transports but keep the conservative session baseline. Native and print session buckets stay isolated.

This file is the public lock for that contract. The silent one-shot stamps live in `src/core/config.ts` (`applyNativeTransportDefaultMigration`, `applyMaxConcurrentDefaultMigration`) and run on the next settings load.
