# Building M3 Code for your own iPhone

The mobile app lives in `apps/mobile` (Expo / React Native). It is already branded as
M3 Code, uses the `no.leep.m3code` bundle identifiers, and builds under this fork's own
Expo account — nothing points at upstream.

This guide covers a personal build only: your Apple Developer account, your phone, no
TestFlight, no App Store, no other users.

## What you need

- A Mac with Xcode installed
- A paid Apple Developer account (a free one signs builds that expire after 7 days)
- Node 24 and pnpm 10 (`packageManager` in the root `package.json` pins the versions)

No `.env` is required. Clerk and the hosted relay are optional and stay off.

## One-time setup on the Mac

```bash
git clone https://github.com/martinbhans1/m3code.git
cd m3code
pnpm install
```

## Build and install

```bash
cd apps/mobile
EXPO_NO_GIT_STATUS=1 APP_VARIANT=production npx expo prebuild --clean --platform ios
npx expo run:ios --device --configuration Release
```

`prebuild` generates the `ios/` folder (gitignored, safe to regenerate any time).
`run:ios --device` lists your connected iPhones and installs to the one you pick.

The first build will fail signing until Xcode knows your team. Open `apps/mobile/ios`
in Xcode once, select the target, set **Signing & Capabilities → Team** to your Apple
Developer team, and let it auto-provision `no.leep.m3code`. Then re-run the command
above. With a paid account the installed build stays valid for a year.

## Connecting it to your machine

The phone talks to the M3 Code server running on your desktop — it does not run agents
itself. Pair it over your tailnet:

1. On the desktop app, open **Settings → Connections** and turn on network access.
2. Pick a Tailscale endpoint as the default, then **Create Link** and show the QR code.
3. In the mobile app, add a connection and scan the QR.

See [remote-access.md](./remote-access.md) for the server side in detail, including
Tailscale Serve for HTTPS.

## Shipping changes without rebuilding

A local build has no update channel, so every change means re-running the build on the
Mac. If that gets tedious, build once through EAS instead:

```bash
npx eas build --profile preview -p ios
```

That produces an internal-distribution build wired to the `preview` update channel.
After that, JavaScript-only changes reach the phone with `npx eas update --channel
preview` — no Mac, no reinstall. Native changes (new Expo modules, config plugin edits,
anything under `modules/`) still need a fresh build.

## Notes

- iOS variants install side by side: `M3 Code`, `M3 Code Dev`, `M3 Code Preview`.
- `npx expo run:ios --device` without `--configuration Release` gives a debug build that
  needs Metro running on the Mac. Use Release for a standalone app.
