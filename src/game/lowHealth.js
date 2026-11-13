// Only live, fresh, local-player data may trigger the stream effect.
export function lowHealthVitals(tracker, config, now) {
  const s = tracker.lastSnapshot;
  const fresh = tracker.connected && now - tracker.lastPacketAt < 15000;
  const active = !!(config?.enabled && fresh && s?.isSelf && s.hasMap &&
    s.mapPhase === 'live' && s.roundPhase === 'live' && s.player?.health > 0 && s.player.health < 20 &&
    !tracker.ignoredMode && tracker.match?.status === 'live');
  return { active, hp: s?.isSelf ? s.player?.health ?? null : null,
    key: `${tracker.match?.matchId ?? ''}:${s?.mapRound ?? ''}`, lastPacketAt: tracker.lastPacketAt };
}
