import { describe, it, expect } from 'vitest';
import { parseVdf, buildCfg } from '../src/gsi/installer.js';

describe('installer', () => {
  it('парсит libraryfolders.vdf с экранированными путями', () => {
    const vdf = String.raw`"libraryfolders"
{
	"0"
	{
		"path"		"C:\Program Files (x86)\Steam"
		"apps" { "730" "123" }
	}
	"1"
	{
		"path"		"D:\SteamLibrary"
	}
}`;
    const d = parseVdf(vdf);
    expect(d.libraryfolders['0'].path).toBe('C:\Program Files (x86)\Steam');
    expect(d.libraryfolders['1'].path).toBe('D:\SteamLibrary');
    expect(d.libraryfolders['0'].apps['730']).toBe('123');
  });

  it('cfg содержит порт и токен', () => {
    const cfg = buildCfg({ port: 3001, token: 'abc123' });
    expect(cfg).toContain('"uri"       "http://127.0.0.1:3001/gsi"');
    expect(cfg).toContain('"token"   "abc123"');
    expect(cfg).toContain('"player_match_stats"  "1"');
  });
});
