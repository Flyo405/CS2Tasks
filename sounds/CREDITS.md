# Звуки

| Файл | Что это | Автор / лицензия | Источник |
|---|---|---|---|
| `complete.mp3` | звук выполненного задания (по умолчанию) | файл стримера | `steam-achievement.mp3` |
| `skip.mp3` | звук пропущенного задания (по умолчанию) | файл стримера | `lego-breaking.mp3` |
| `alt-sad-trombone.wav` | грустный тромбон | Sad Tromboner, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Sad_Trombone.wav) |
| `alt-sad-trombone-short.ogg` | грустный тромбон, короткий | Joe Lamb, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Sad_Trombone-Joe_Lamb-665429450.ogg) |
| `alt-achievement.wav` | «achievement unlocked» | rhodesmas, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Achievement_unlocked_sound_effect_video_game.wav) |
| `skip-synth.wav`, `complete-synth.wav` | синтезированные запасные | этот проект, без ограничений | `tools/makeSounds.js` |

Звуки `alt-*` под лицензией CC BY: если включите их на стриме, укажите автора (например, в описании канала).

Свой звук: положите файл (mp3 / wav / ogg) в эту папку и укажите его имя в настройках
(«Звук пропуска» / «Звук выполнения») или в `data/config.json` → `sounds.skip` / `sounds.complete`.

`heartbeat.wav`: original synthesized double heartbeat, ten seconds with a baked-in fade; generated for this project, no external recording.
