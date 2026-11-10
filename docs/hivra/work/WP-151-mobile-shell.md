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
- **EAS profiles.** `development-simulator` stays. The inherited production block is unchanged and has no store credentials. Do not run the production build, submit, or beta-update scripts.
- **The daily desktop app.** Nothing in this package launches, copies, or ships `~/Applications/MonoCode Hub.app`.

## Icons

The asset paths stay as they are, so the existing imports stay. `mobile/scripts/placeholder-icons.py` overwrites those pixels with a placeholder H (app icon, splash, favicon, in-app mark and its inverse, Android adaptive layers) and leaves the native transcript artwork alone. It was not run in this package: the command runner would not start Python. Until it runs, the files are still the inherited MonoCode glyphs.
