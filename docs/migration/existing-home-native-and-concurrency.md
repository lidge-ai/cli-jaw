# Existing-home native ACP and concurrency 20

Existing `settings.json` homes stay on print transport and `multiSession.maxConcurrent: 2` because load pins those old defaults. The next settings load will migrate them.

Tracked in [#761](https://github.com/lidge-jun/cli-jaw/issues/761).

| Surface | After the next load |
| --- | --- |
| `perCli.cursor` / `claude` / `grok` `transport` | `native` once, when permissions allow (Cursor/Grok: `auto`; Claude: `auto` or `safe`). A later explicit `print` is kept. |
| `multiSession.maxConcurrent` | `20` when the stored value is exactly `2`. Other integers stay. |
| New homes | Same defaults. No Settings banner. Schema stays v4. |

Restrictive Claude (`custom` / not `auto`|`safe`) stays print so spawn does not refuse the next run. Established homes with no settings file stay conservative across boots. Native and print session buckets stay isolated.

This file is the public lock for that contract. The silent one-shot stamps live in `src/core/config.ts` (`applyNativeTransportDefaultMigration`, `applyMaxConcurrentDefaultMigration`) and run on the next settings load.
