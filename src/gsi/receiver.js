// POST /gsi: проверка токена, быстрый ответ 200, обработка после ответа.
import { log } from '../log.js';

export function createGsiHandler({ getConfig, onPacket, recorder }) {
  let lastAuthWarn = 0;
  return (req, res) => {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { res.status(400).end(); return; }
    }
    if (!body || typeof body !== 'object') { res.status(400).end(); return; }
    const token = body.auth?.token;
    if (!token || token !== getConfig().gsiToken) {
      const now = Date.now();
      if (now - lastAuthWarn > 60_000) {
        lastAuthWarn = now;
        log.warn('Пакет GSI с неверным токеном отклонён. Переустановите GSI cfg в панели и перезапустите CS2.');
      }
      res.status(401).end();
      return;
    }
    res.status(200).end();
    const receivedAt = Date.now();
    setImmediate(() => {
      try {
        recorder?.write(body, receivedAt);
        onPacket(body, receivedAt);
      } catch (e) {
        log.error('Ошибка обработки пакета GSI:', e.stack || e.message);
      }
    });
  };
}
