export function releaseRepository(value) {
  const name = String(value ?? '').trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git\/?$|\/$/i, '');
  return /^[\w.-]+\/[\w.-]+$/.test(name) && !name.split('/').some((part) => part === '.' || part === '..') ? name : null;
}

function stableVersion(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value ?? '');
  return match?.slice(1).map(Number);
}

export async function checkForUpdate(repository, current, fetchRelease = fetch) {
  const repo = releaseRepository(repository);
  const installed = stableVersion(current);
  if (!repo || !installed) return null;
  try {
    const response = await fetchRelease(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CS2Tasks' },
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok) return null;
    const release = await response.json();
    const latest = stableVersion(release.tag_name);
    if (!latest || release.draft || release.prerelease) return null;
    const difference = latest.findIndex((part, index) => part !== installed[index]);
    if (difference < 0 || latest[difference] < installed[difference]) return null;
    return { version: latest.join('.'), url: `https://github.com/${repo}/releases/tag/${release.tag_name}` };
  } catch {
    return null;
  }
}
