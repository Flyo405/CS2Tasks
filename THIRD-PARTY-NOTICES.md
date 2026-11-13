# Third-party notices

## Audio

| Файл | Что это | Автор / лицензия | Источник |
|---|---|---|---|
| `complete.mp3` | звук выполненного задания (по умолчанию) | файл стримера | `steam-achievement.mp3` |
| `skip.mp3` | звук пропущенного задания (по умолчанию) | файл стримера | `lego-breaking.mp3` |


Свой звук: положите файл (mp3 / wav / ogg) в эту папку и укажите его имя в настройках
(«Звук пропуска» / «Звук выполнения») или в `data/config.json` → `sounds.skip` / `sounds.complete`.

`heartbeat.wav`: original synthesized double heartbeat, ten seconds with a baked-in fade; generated for this project, no external recording.

## Counter-Strike icons

Counter-Strike equipment silhouettes
Source: https://github.com/moongunlol/csgo-icon (swf_vectors_final.zip)
Original game artwork: Valve. Extracted Counter-Strike HUD vectors; not newly drawn CS2 artwork.

HUD symbols in icons.js (headshot, flashbang, smoke grenade, molotov flame, skull, kevlar, armor, adrenaline syringe, HE grenade, planted bomb)
come from the same source and are recolored to currentColor and cropped. Other task symbols in icons.js
(star, bullet, assist, dollar, flag, trophy, chart, pencil, cross, 360 arrow, jump, noscope, crosshair, chevrons, plus, bolt)
are drawn for this project.
