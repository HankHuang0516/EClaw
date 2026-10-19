# Fraud Empire web demo retirement (2026-10-19)

The public web demo is withdrawn at the user's request. Android/iOS app development is a separate, unfinished effort; this change does not deliver a native app or submit a store build.

## Public contract

- Keep the general project introduction at /AiHankApps/projects/fraud-empire/.
- Return an app-development notice and HTTP 410 for former play pages, preview query variants, private-host-r15, runtime scripts, manifests, media and other game artifacts.
- Apply the same retirement to the existing /mission/AiHankApps/projects/fraud-empire/ static alias, including encoded/normalized paths.
- Keep only existing root icon PNGs available through their original static handling.
- Serve a retirement worker at both existing worker script locations. Its installation intentionally replaces the former explicit game-upgrade protocol: immediate activation is restricted to these retired project scopes only.
- The retirement worker deletes only this project's static/meta CacheStorage namespaces, navigates its online project clients to the introduction, and unregisters itself. It never reads or deletes personal saved games, IndexedDB, cookies or unrelated app caches.
- The notice updates only already-existing exact-scope registrations; it never registers a new worker.

## Preservation and limitations

Original game source files, art, planning documents, test evidence, Git history and stored player progress remain preserved. This is a server response change, not permanent removal of source material.

An offline device or an already downloaded independent copy cannot be guaranteed to be remotely withdrawn. Browser worker updates also depend on connectivity. Do not represent VM/unit worker fixtures as an installed-device production test.

The portfolio's unrelated app pages and pending Timehut work are outside this change. Do not reapply an older whole homepage snapshot over the retirement.
