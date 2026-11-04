# Default plugins (WP-41)

Every folder here is a plugin Hivra installs and switches on everywhere by itself, once per data folder. Each is pinned
in [`defaults.json`](defaults.json) and embedded in the app binary by `src-tauri/build.rs`, so the first start needs
no download and every platform gets it (bundle resources are off on Linux and Windows). How it works and what each CLI
gets: [docs/hivra/plugins/README.md](../../docs/hivra/plugins/README.md#default-plugins-wp-41).

| Folder | Upstream | Commit | Licence |
| --- | --- | --- | --- |
| `pstack` | [cursor/plugins `pstack`](https://github.com/cursor/plugins/tree/main/pstack), Lauren Tan | `6ea74587` (0.15.36) | MIT, `pstack/LICENSE` |

## Updating pstack to a newer commit

Copy the folder unchanged from the new commit, leaving out what `left_out` lists, then update the pin:

```bash
git clone --filter=blob:none --sparse https://github.com/cursor/plugins /tmp/cp && cd /tmp/cp
git checkout <commit> && git sparse-checkout set pstack && cd -
rm -rf src-tauri/plugins/pstack && mkdir src-tauri/plugins/pstack
(cd /tmp/cp/pstack && tar cf - --exclude ./.cursor-plugin --exclude ./.gitignore --exclude ./agents \
  --exclude ./automations --exclude ./assets --exclude ./docs/guide/images \
  --exclude ./skills/statechart/scripts/test .) | tar xf - -C src-tauri/plugins/pstack
# defaults.json: commit, version (from plugin.json); NOTICE: the commit
UPDATE_PLUGIN_WIRING_SNAPSHOT=1 cargo test --manifest-path src-tauri/Cargo.toml --lib plugins::defaults_tests
```

`plugins::defaults_tests` checks the pin against the folder (name, version, licence, nothing left out sneaking back) and
the embedded bytes against the files. A data folder that was already given pstack keeps the copy it has: moving an
existing install to the new commit is an update, which is WP-31's job.
