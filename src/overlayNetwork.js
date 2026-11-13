import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

export function isPrivateIPv4(address) {
  if (typeof address !== 'string' || !isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

export function overlayInterfaces() {
  return Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? []).filter((entry) => !entry.internal && isPrivateIPv4(entry.address))
      .map((entry) => ({ name, address: entry.address })));
}

// The network listener gets the data used by the overlays, without panel diagnostics and settings.
export function overlayMessage(message) {
  if (message.type !== 'state') return message;
  const { serverTime, match, bingo, tasks, taskVote, points, gsi, session, bonuses, matchReports, healthEffect, settings } = message.state;
  const { language, sounds, overlay, bonuses: bonusSettings, summary, lowHealth } = settings;
  return {
    type: 'state',
    state: {
      serverTime, match, bingo, tasks, taskVote, points, bonuses, matchReports: matchReports?.slice(0, 1),
      gsi: { connected: gsi.connected, inMenu: gsi.inMenu },
      session: { completed: session.completed },
      healthEffect: healthEffect && {
        active: healthEffect.active, key: healthEffect.key,
        startedAt: healthEffect.startedAt, lastPacketAt: healthEffect.lastPacketAt,
      },
      settings: { language, sounds, overlay, bonuses: bonusSettings, summary, lowHealth: { enabled: lowHealth.enabled, volume: lowHealth.volume } },
    },
  };
}
