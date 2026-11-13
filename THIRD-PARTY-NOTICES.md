# Third-party notices

## Audio

| File | Use | Provided by | Original filename |
|---|---|---|---|
| `complete.mp3` | Default challenge completion sound | Streamer | `steam-achievement.mp3` |
| `skip.mp3` | Default sound for skipped challenges | Streamer | `lego-breaking.mp3` |


To use a custom sound, put the MP3, WAV, or OGG file in the `sounds/` folder. Enter its filename under **Skip sound** or **Completion sound** in Settings, or set `sounds.skip` or `sounds.complete` in `data/config.json`.

`heartbeat.wav`: original synthesized double heartbeat, ten seconds with a baked-in fade; generated for this project, no external recording.

## Counter-Strike icons

Counter-Strike equipment silhouettes
Source: https://github.com/moongunlol/csgo-icon (swf_vectors_final.zip)
Original game artwork: Valve. Extracted Counter-Strike HUD vectors; not newly drawn CS2 artwork.

HUD symbols in icons.js (headshot, flashbang, smoke grenade, molotov flame, skull, kevlar, armor, adrenaline syringe, HE grenade, planted bomb)
come from the same source and are recolored to currentColor and cropped. Other task symbols in icons.js
(star, bullet, assist, dollar, flag, trophy, chart, pencil, cross, 360 arrow, jump, noscope, crosshair, chevrons, plus, bolt)
are drawn for this project.
