# CS2 Tasks

CS2 Tasks adds challenges to your Counter-Strike 2 matches and shows your progress in OBS. Play with regular challenges, fill a bingo card, or aim for a points target. If you stream on Twitch, chat can vote for a bonus challenge.

## Getting started

1. Download `CS2Tasks.exe` from the [latest release](https://github.com/Flyo405/CS2Tasks/releases/latest).
2. Put it in its own folder and run it. The executable is built for 64-bit Windows.
3. If CS2 is already running, restart it so it can load the Game State Integration (GSI) config.
4. The dashboard usually opens automatically. You can also double-click the **CS2 Tasks** icon in the Windows system tray.

The app gets match data through GSI. For challenges like flick kills, it also tracks relevant keyboard and mouse input while CS2 is in focus. It runs outside the game process and does not inject into it.

## OBS setup

Add a **Browser** source in OBS and use `http://127.0.0.1:3000/overlay` as the URL. Start with **500 × 600** for the challenge list. For score popups and match summaries, add separate Browser sources sized to your scene.

| Source | URL |
| --- | --- |
| Dashboard | `http://127.0.0.1:3000/panel` |
| Challenges | `http://127.0.0.1:3000/overlay` |
| Score and bonuses | `http://127.0.0.1:3000/bonuses` |
| Match summary | `http://127.0.0.1:3000/summary` |

If OBS runs on a second PC, select the gaming PC’s network address in Settings and restart CS2 Tasks. The **GSI & OBS** tab shows the URLs to use on the second PC and whether the app is receiving data from CS2.

The dashboard and overlays default to English on first launch. Use **RU / EN** in the dashboard to switch languages.

## Updates

The release executable checks GitHub for a newer stable version at startup. When one is available, the dashboard and system tray link to the release. To update, exit CS2 Tasks from the tray and replace the executable in the same folder. Keep the `data` folder to retain your settings and history.

## Build from source

On 64-bit Windows with Node.js 22:

```powershell
npm ci
npm test
npm start
```

Run `npm run build:exe` to build `dist/CS2Tasks.exe`. The update checker uses the repository in `package.json` by default. For a local build of a fork, set `$env:CS2TASKS_UPDATE_REPO = 'owner/repository'` before building. GitHub Actions uses the repository where the workflow runs.

[Detailed guide (Russian)](docs/guide-ru.md) · [Release instructions (Russian)](docs/releasing.md) · [Sound credits](sounds/CREDITS.md) · [Game icon credits](public/overlay/weapon-icons-CREDITS.md)
