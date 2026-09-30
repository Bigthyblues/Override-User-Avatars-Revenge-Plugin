# Override User Avatars for Revenge

A **local-only** Revenge plugin which displays one configured Discord user with a custom avatar. It does not edit a Discord profile or make Discord REST requests; the image URL is used only as a client-side render source.

Original plugin by [Furretar](https://github.com/Furretar). The original attribution remains in the plugin manifest and the project remains under its existing license.

## Install

Paste this URL into Revenge's **Install Plugin** screen:

```text
https://bigthyblues.github.io/Override-User-Avatars-Revenge-Plugin/Override-User-Avatars/
```

Then enter a Discord user ID and a direct `http://` or `https://` image URL. For example:

```text
https://i.imgur.com/yZ5wSQC.png
```

Use **Test / Refresh** after changing a value if an already-open screen does not redraw. Reinstalling the plugin is not necessary: hooks read the live settings each time they run.

## Version 2.0 design

The 1.x implementation copied `targetUserId` and `imageUrl` into constants during `onLoad`. A settings change therefore could not affect installed hooks until the plugin was reloaded. It also replaced two properties directly and assumed every avatar went through `getUserAvatarURL` or `getUserAvatarSource`.

Version 2.0:

- reads and validates current storage values at hook execution time;
- uses Revenge's patcher so every hook has a corresponding unpatch;
- instruments both discovered avatar helpers and the specifically named `Avatar` component export;
- never patches React Native's global `Image` component;
- accepts a User object, an explicit user ID, or a Discord CDN avatar URL which embeds the exact configured ID;
- requires an exact user match before changing a source; and
- rate-limits path/replacement messages to one log entry per plugin load under the `[LocalAvatarOverride]` tag.

The old helper hooks existing in a bundle is **not evidence that every current surface calls them**. The reported Discord 347.12 symptom is consistent with call sites bypassing those helpers, but without a runtime trace from that proprietary bundle this is not claimed as the sole confirmed cause. Enable debug logging and inspect logcat to see which discovered path actually performs a replacement.

## Discord 347.12 (6518) compatibility status

The plugin is designed for and has been statically reviewed against the reported 347.12 failure mode. This repository's development environment cannot run the Android Discord client, so the following device checks remain explicit rather than being presented as completed:

| Surface | Intended path | 347.12 physical-device status |
| --- | --- | --- |
| Channel message avatar | avatar helper or scoped `Avatar` component | Needs device verification |
| DM list/header | avatar helper or scoped `Avatar` component | Needs device verification |
| User profile | avatar helper or scoped `Avatar` component | Needs device verification |
| Member list | avatar helper or scoped `Avatar` component | Needs device verification |
| Reply/quote preview | avatar helper or scoped `Avatar` component | Needs device verification |
| Voice UI | `getUserAvatarURL` or scoped `Avatar` component | Needs device verification |
| Search results | avatar helper or scoped `Avatar` component | Needs device verification |
| Android system notifications | Outside the in-app render hooks | Not supported |

Some Discord surfaces memoize image sources or use private/native components. **Test / Refresh** sends a local Flux `USER_UPDATE` for the already-cached user, but cannot guarantee that every mounted surface invalidates its cache. The plugin intentionally leaves an unverified surface unchanged rather than applying a dangerous global image patch.

## Diagnostics

Filter Android logs for:

```text
[LocalAvatarOverride]
```

Startup reports whether the helper and component modules were found and which hooks installed. The first replacement through each path is logged once. If no replacement entry appears, open the affected surface after pressing **Test / Refresh** and collect those tagged lines.

## Safety and privacy

- No Discord REST API calls, messages, clicks, follows, friend requests, profile edits, or uploads are performed.
- Only the configured image host is contacted by Discord/React Native when it renders the supplied image URL.
- Invalid IDs and non-HTTP(S) URLs disable replacement.
- Disabling/unloading removes all hooks and restores Discord's normal rendering.

## Development

```sh
pnpm install
pnpm build
pnpm verify
```

The generated Revenge-installable files are written to `dist/Override-User-Avatars/` (`manifest.json` plus `index.js`).

After a successful deployment from `master`, import the plugin into Revenge with:

```text
https://bigthyblues.github.io/Override-User-Avatars-Revenge-Plugin/Override-User-Avatars/
```

The workflow publishes through GitHub's official Pages artifact deployment and shows the deployed site URL in the `github-pages` environment. It can also be rerun manually from **Actions → Build and deploy Revenge plugin → Run workflow**. A deployment is stopped before publishing if the generated manifest, entry point, version, bundle, or SHA-256 hash is invalid.

## Preview

<img src="https://github.com/user-attachments/assets/81cf73b4-28e3-43f4-9d9c-2050dd027a5b" width="40%"><img src="https://github.com/user-attachments/assets/cfbf3e0e-dfbc-4d36-abd1-37880cd5b54d" width="40%">
