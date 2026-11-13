import { expect, it } from 'vitest';
import { Core } from '../src/core.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { raw } from './helpers.js';

it('takes chat commands for thirty seconds and awards a separate task before opening another vote', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config.twitch, { enabled: true, taskVoting: true, channel: 'test', allowedRoles: ['moderator'] });
  Object.assign(config.tasks, { count: 0, maxActive: 1 });
  let now = 100000;
  let chatMessage;
  const core = new Core({
    config, now: () => now, rng: () => 0,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    templates: { templates: ['kills', 'headshots', 'assists', 'round_wins'].map((type) => ({
      type, params: { count: 1 }, difficulty: 'medium', weight: 1,
    })), errors: [] },
    chatProviderFactory: ({ onStatus }) => ({
      onMessage(handler) { chatMessage = handler; },
      async connect() { onStatus({ connected: true, canSay: false, channel: 'test' }); },
      async disconnect() {},
      say() {},
    }),
  });
  await core.restartChat();
  core.ingest(raw());
  core.tasks.add({ type: 'manual', params: { text: 'Main task', count: 1 } });
  const poll = core.getState().taskVote;
  expect(poll.options).toHaveLength(4);
  expect(poll.endsAt).toBe(now + 30000);
  chatMessage({ user: 'Alice', text: '!task custom Viewer task' });
  expect(core.suggestions.queue).toHaveLength(0);
  chatMessage({ user: 'Mod', roles: new Set(['moderator']), text: '!task custom Moderator task' });
  expect(core.suggestions.queue).toHaveLength(1);
  await core.updateConfig({ twitch: { enabled: false } });
  expect(core.getState().chat.connected).toBe(true);
  chatMessage({ user: 'OtherMod', roles: new Set(['moderator']), text: '!task custom Disabled suggestions' });
  expect(core.suggestions.queue).toHaveLength(1);
  await core.updateConfig({ twitch: { voteAllowedRoles: ['moderator'] } });
  chatMessage({ user: 'Alice', text: '!3' });
  expect(core.getState().taskVote.counts).toEqual([0, 0, 0, 0]);
  await core.updateConfig({ twitch: { voteAllowedRoles: ['everyone'] } });
  chatMessage({ user: 'Alice', text: '!2' });
  chatMessage({ user: 'ALICE', text: '!1' });
  chatMessage({ user: 'Bob', text: '!1' });
  expect(core.getState().taskVote.counts).toEqual([2, 0, 0, 0]);
  now = poll.endsAt;
  chatMessage({ user: 'Bob', text: '!4' });
  core.tick();
  expect(core.getState().taskVote).toBeNull();
  expect(core.tasks.active()).toHaveLength(2);
  expect(core.tasks.mainActive()).toHaveLength(1);
  const winner = core.tasks.active().find((task) => task.source === 'vote');
  expect(winner.type).toBe(poll.options[0].type);
  core.tasks.complete(winner.id);
  core.tick();
  expect(core.getState().taskVote.counts).toEqual([0, 0, 0, 0]);
  core.ingest(raw({ menu: true }));
  expect(core.getState().taskVote).toBeNull();
  await core.shutdown();
});
