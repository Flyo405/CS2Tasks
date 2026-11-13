// Запись сырых пакетов GSI в data/gsi-log-<дата>.jsonl (для фикстур, отладки и --replay).
import fs from 'node:fs';
import path from 'node:path';

export function createRecorder({ dataDir, isEnabled }) {
  let stream = null;
  let streamDay = null;
  return {
    write(packet, now = Date.now()) {
      if (!isEnabled()) {
        if (stream) { stream.end(); stream = null; }
        return;
      }
      const day = new Date(now).toISOString().slice(0, 10);
      if (!stream || day !== streamDay) {
        if (stream) stream.end();
        streamDay = day;
        stream = fs.createWriteStream(path.join(dataDir, `gsi-log-${day}.jsonl`), { flags: 'a' });
      }
      const { auth, ...rest } = packet; // токен в лог не пишем
      stream.write(JSON.stringify({ t: now, p: rest }) + '\n');
    },
    close() {
      if (stream) stream.end();
      stream = null;
    },
  };
}
