// Full-screen stream pulse. Actual desaturation belongs to the OBS capture filter.
const layer = document.createElement('div');
layer.id = 'low-health'; layer.hidden = true; document.body.prepend(layer);
let active = false, key = null, lastStateAt = 0, packetAt = 0, audio = null, settings = null;
function stop() {
  active = false; layer.hidden = true;
  if (audio) { audio.pause(); audio = null; }
}
function apply(s) {
  settings = s.settings.lowHealth;
  const v = s.healthEffect;
  lastStateAt = Date.now(); packetAt = v?.lastPacketAt;
  if (s.gsi?.inMenu || !settings?.enabled || !v?.active) { stop(); key = v?.key; return; }
  if (active && key === v.key) return;
  stop(); active = true; key = v.key;
  layer.hidden = false;
  const elapsed = Math.max(0, (s.serverTime - (v.startedAt ?? s.serverTime)) / 1000);
  if (elapsed >= 10) return;
  audio = new Audio('/sounds/heartbeat.wav');
  audio.currentTime = elapsed;
  audio.volume = settings.volume;
  audio.play().catch(() => {});
}
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'state') apply(m.state);
  };
  ws.onclose = () => { stop(); setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
}
// Guard against a frozen socket/GSI stream, even if the server stops broadcasting.
let seenPacketAt = null, seenPacketTime = 0;
setInterval(() => {
  if (packetAt !== seenPacketAt) { seenPacketAt = packetAt; seenPacketTime = Date.now(); }
  if (Date.now() - lastStateAt > 15000 || Date.now() - seenPacketTime > 15000) stop();
}, 500);
connect();
