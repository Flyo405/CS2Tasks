import { expect, it, vi } from 'vitest';
import { checkForUpdate } from '../src/updates.js';

it('finds a newer stable version and constructs a GitHub release link', async () => {
  const get = vi.fn(async () => ({ ok: true, json: async () => ({ tag_name: 'v1.10.0', html_url: 'https://example.com' }) }));
  await expect(checkForUpdate('https://github.com/owner/project', '1.9.9', get)).resolves.toEqual({
    version: '1.10.0', url: 'https://github.com/owner/project/releases/tag/v1.10.0',
  });
  expect(get).toHaveBeenCalledWith('https://api.github.com/repos/owner/project/releases/latest', expect.any(Object));
});

it.each(['v1.9.9', 'v1.9.8', 'v2.0.0-beta.1'])('ignores %s', async (tag_name) => {
  await expect(checkForUpdate('owner/project', '1.9.9', async () => ({
    ok: true, json: async () => ({ tag_name }),
  }))).resolves.toBeNull();
});

it('skips an unconfigured repository and tolerates network errors', async () => {
  const get = vi.fn(async () => { throw new Error('offline'); });
  await expect(checkForUpdate(null, '1.0.0', get)).resolves.toBeNull();
  expect(get).not.toHaveBeenCalled();
  await expect(checkForUpdate('owner/project', '1.0.0', get)).resolves.toBeNull();
});
