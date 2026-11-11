# WP-151: Mobile app shell identity

Private development build of the inherited Expo app. Nothing here is submitted to the App Store or Play Store, and the desktop app's identity is not part of this package.

## Ids and scheme

| | Inherited | This build |
| --- | --- | --- |
| App name | MonoCode | Hivra |
| Home-screen name | Monocode | Hivra |
| Slug | monocode-mobile | hivra-mobile |
| iOS bundle id | com.hardbeat920.monocode-mobile | com.ash.hivra.mobile |
| Android package | unset | com.ash.hivra.mobile |
| URL scheme the app registers | monocode | hivra |
| Expo owner | hardbeat920 | removed |
| EAS project | f80fe97b-6056-48a4-9fb2-b45ca2c8974b | removed |
| Over-the-air updates | https://u.expo.dev/f80fe97b-6056-48a4-9fb2-b45ca2c8974b | off |

`com.ash.hivra.mobile` is only the phone app. It is not the desktop bundle id, so it does not move the desktop data folder, Keychain names, or the installed app path.

## Left alone on purpose

- **WP-07 step 2.** The desktop identifier stays `com.ash.monocode-hub`. This package does not migrate data and does not ask for a new desktop id.
- **Pairing payload.** The desktop still builds `monocode://pair?i=…`. The phone still accepts only that scheme. A `hivra://` link is rejected, so the phone cannot drift ahead of the desktop. The registered app scheme (`hivra`) is how the phone app is opened; it is not the pairing protocol.
- **Native module.** `MonocodeLink` and the Rust link stay under their code names. Those are not the name on the home screen.
- **EAS profiles.** `development`, `development-simulator` and `preview` stay. The inherited production build profile, the submit section and the `build:ios`, `submit:ios` and `update:beta` scripts are deleted (10 Nov 2026), and `mobile/tests/hivraIdentity.test.ts` fails if any comes back.
- **The daily desktop app.** Nothing in this package launches, copies, or ships `~/Applications/MonoCode Hub.app`.

## Icons

The asset paths stay as they are, so the existing imports stay. The inherited glyphs are now a placeholder H (app icon, splash, favicon, in-app mark and its inverse, Android adaptive layers). The native transcript artwork was left alone. The one-shot script that painted those pixels was removed after the images were checked.
