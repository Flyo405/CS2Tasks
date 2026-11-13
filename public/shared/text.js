import { en, hints } from './catalog.js';
const dictionary = { ...en, ...hints, 'Команда чата':'Chat command',
 'текст длиннее 80 символов':'text exceeds 80 characters', 'ссылки в заданиях запрещены':'links are not allowed in challenges',
 'в тексте есть запрещённые слова':'the text contains banned words', 'неизвестный пользователь':'unknown user',
 'твоё прошлое предложение ещё ждёт модерации':'your previous suggestion is still awaiting moderation',
 'очередь предложений заполнена, попробуй позже':'the suggestion queue is full; try again later', 'неизвестный тип задания':'unknown challenge type',
 'Начать новый матч? Незавершённые задания текущего матча будут провалены.':'Start a new match? Unfinished challenges in this match will fail.',
 'Сбросить бонусные очки за сессию? Задания сохранятся.':'Reset session bonus points? Challenges will be kept.',
};
const fragments = {
  'СИТУАЦИОННОЕ': 'SITUATIONAL', '(чтение)': '(read-only)', '(не считается)': '(not tracked)',
  '(из настроек программы)': '(manual setting)', '(из настроек CS2)': '(CS2 settings)',
  '✗ не работает': '✗ not running',
  'Неизвестное оружие:': 'Unknown weapon:', 'Неизвестный тип оружия:': 'Unknown weapon class:',
  'ожидался массив шаблонов': 'expected an array of templates', 'ожидался объект': 'expected an object',
  'тип manual нельзя генерировать случайно': 'manual challenges cannot be randomly generated',
  'weight должен быть числом больше 0': 'weight must be a number greater than 0',
  'params должен быть объектом': 'params must be an object',
  'диапазон допустим только для чисел': 'ranges are only supported for numbers',
  'min больше max': 'min exceeds max', 'диапазон должен быть в пределах': 'range must be within',
  'пустой список вариантов': 'empty list of choices', 'нет параметров': 'no parameters',
  'выберите локальный IPv4 игрового ПК': 'choose a local IPv4 address for the gaming PC',
  'укажите канал, чтобы включить чат': 'enter a channel to enable chat',
  'команда без пробелов, например !task': 'enter a command without spaces, e.g. !task',
  'имя файла из папки sounds (без пути)': 'enter a filename from the sounds folder without a path',
  'непустой массив из': 'expected a non-empty array containing',
  'массив строк': 'expected an array of strings', 'цвет #RRGGBB': 'expected a #RRGGBB color',
  'нужен { "type": ... }': 'expected { "type": ... }',
  'OBS: ошибка': 'OBS error:', 'OBS не ответил:': 'No response from OBS:',
  'пропуск −': 'skip −',
  'РИСК': 'RISK', 'РАЗНООБРАЗИЕ':'VARIETY',
  'предлагает': 'suggests', 'зритель': 'viewer', 'зрителя': 'viewer', 'Оружие:': 'Weapons:', 'Типы оружия:': 'Weapon classes:',
  'Пистолетный раунд': 'Pistol round', 'Дешёвая закупка': 'Eco buy', 'Без брони': 'No armor',
  'ситуационное': 'situational', 'на этот раунд': 'this round', 'макс.': 'max.', 'доп.': 'extra', 'очк.': 'pts',
  'пропущено': 'skipped', 'провалено': 'failed', 'наблюдалась часть матча': 'partially observed',
  'победа': 'victory', 'поражение': 'defeat', 'ничья': 'draw', 'окончен': 'finished',
  'недоступно': 'unavailable', 'от @': 'by @', 'зритель @': 'viewer @', 'разминка': 'warmup',
  'отсчётов мыши': 'mouse counts', 'допуск': 'tolerance', 'вправо': 'right', 'влево': 'left',
  'Пакеты для диагностики:': 'Diagnostic packets:', 'Максимум убийств за раунд:': 'Best round kills:',
  'Пропущено заданий:': 'Skipped:', 'Провалено:': 'Failed:', 'Статистика наблюдаемой части матча': 'Observed portion of the match',
  'Задание добавлено': 'Challenge added', 'Неизвестный тип задания:': 'Unknown challenge type:',
  'Неизвестное сочетание:': 'Unknown combo:', 'Некорректный JSON': 'Invalid JSON', 'Нет такого метода API': 'Unknown API endpoint',
  'Нет заголовка X-CS2Tasks': 'Missing X-CS2Tasks header', 'Ошибки:': 'Errors:',
  'Команда отправлена в OBS; проверьте статус сохранения': 'Command sent to OBS; check the save status',
  'Включите подключение к OBS в настройках': 'Enable the OBS connection in Settings',
  'OBS не подключён': 'OBS is not connected', 'OBS подключён': 'OBS connected', 'OBS отключился': 'OBS disconnected',
  'Буфер повторов OBS выключен. Запустите его в OBS или включите автозапуск в настройках программы.': 'The OBS replay buffer is off. Start it in OBS or enable automatic startup in Settings.',
  'OBS уже сохраняет повтор': 'OBS is already saving a replay',
  'OBS принял команду, но путь сохранённого повтора пока не подтверждён': 'OBS accepted the command, but the saved replay path has not been confirmed yet',
  'Эйс': 'Ace', 'Сложное комбо': 'Difficult combo', 'Тест из панели': 'Dashboard test', 'Вручную': 'Manual',
  'GSI cfg не установлен:': 'GSI config not installed:', 'Установка cfg пропущена (--no-install)': 'Config installation skipped (--no-install)',
  'GSI cfg установлен. Перезапустите CS2, чтобы игра его подхватила!': 'GSI config installed. Restart CS2 to load it.',
  'GSI cfg уже актуален': 'GSI config is up to date',
  'GSI cfg только что установлен — перезапустите CS2, чтобы игра начала присылать данные.': 'GSI config was installed. Restart CS2 to start receiving data.',
};
const ordered = Object.entries(fragments).sort((a, b) => b[0].length - a[0].length);

export function translate(value, language = 'ru') {
  if (language !== 'en' || typeof value !== 'string') return value;
  const normalized = value.replace(/\s+/g, ' ').trim();
  const direct = dictionary[normalized];
  if (direct != null) return value.match(/^\s*/)[0] + direct + value.match(/\s*$/)[0];
  let text = value;
  for (const [from, to] of ordered) text = text.split(from).join(to);
  return text
    .replace(/(^|: )строка$/g, '$1expected a string')
    .replace(/: объект(?= |$)/g, ': expected an object')
    .replace(/: true или false$/g, ': expected true or false')
    .replace(/(целое число|число) от (\S+) до (\S+)/g, (_, kind, min, max) => `expected ${kind === 'число' ? 'a number' : 'an integer'} from ${min} to ${max}`)
    .replace(/неизвестная сложность «([^»]*)»/g, 'unknown difficulty "$1"')
    .replace(/плохой код «([^»]*)»/g, 'invalid command alias "$1"')
    .replace(/неизвестный тип «([^»]*)»/g, 'unknown type "$1"')
    .replace(/неизвестный параметр «([^»]*)» \(есть: ([^)]*)\)/g, 'unknown parameter "$1" (available: $2)')
    .replace(/значение (.+) вне пределов (\S+)/g, 'value $1 is outside $2')
    .replace(/^Шаблон #(\d+)(?=[: (])/g, 'Template #$1')
    .replace(/Уже (\d+) активных заданий — это максимум \(tasks.maxActive\)/g, 'Already at the limit of $1 active challenges (tasks.maxActive)')
    .replace(/Уже есть (\d+) или больше активных заданий/g, 'There are already $1 or more active challenges')
    .replace(/Помощник ввода завершился \(код (.+?)\), перезапуск…/g, 'Input helper exited (code $1). Restarting…')
    .replace(/Нет связи с OBS на порту (\d+)\. Проверьте WebSocket и пароль\./g, 'Cannot connect to OBS on port $1. Check the WebSocket and password.')
    .replace(/IP (\S+) не найден на игровом ПК\. Выберите актуальный адрес в настройках\./g, 'IP $1 was not found on the gaming PC. Choose its current address in Settings.')
    .replace(/подожди ещё (\d+) с/g, 'wait another $1s')
    .replace(/(\d+) с назад/g, '$1s ago').replace(/(\d+) мин назад/g, '$1m ago')
    .replace(/(\d+)° (right|left) за ([\d.]+) с/g, '$1° $2 in $3s')
    .replace(/раунд (\d+)/g, 'round $1').replace(/\(нужно (\d+)°\)/g, '(target $1°)')
    .replace(/GSI: нет данных с (.+)/g, 'GSI: no data since $1')
    .replace(/Чат: #/g, 'Chat: #').replace(/Чат: не подключён/g, 'Chat: disconnected')
    .replace(/Последний пакет: /g, 'Last packet: ').replace(/Добавлено заданий: /g, 'Challenges added: ')
    .replace(/Добавлено: /g, 'Added: ').replace(/Сохранено (\d+) пакетов: /g, 'Saved $1 packets: ')
    .replace(/Повтор сохранён: /g, 'Replay saved: ').replace(/Ошибки в templates.json \(эти шаблоны пропущены\):/g, 'Invalid templates (skipped):')
    .replace(/Режим «(.+)» не входит в allowedModes — прогресс не считается\./g, 'Mode "$1" is not in allowedModes — progress is not tracked.')
    .replace(/Template #(\d+): параметры — некорректный JSON/g, 'Template #$1: invalid parameters JSON')
    .replace(/Ошибка (\d+)/g, 'Error $1');
}
