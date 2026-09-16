import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function selectScope(paths, full = false) {
  const scope = { server: full, web: full, driver: full };
  for (const path of paths) {
    if (/\.(md|mdx)$/.test(path)) continue;
    if (path.startsWith('apps/web/')) scope.web = true;
    else if (path.startsWith('apps/driver/')) scope.driver = true;
    // Shared contracts and unknown paths conservatively invalidate every consumer.
    else Object.keys(scope).forEach(key => { scope[key] = true; });
  }
  return { ...scope, code: Object.values(scope).some(Boolean) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const full = process.env.GITHUB_EVENT_NAME !== 'pull_request';
  const base = process.env.CI_BASE_SHA;
  if (!full && !/^[0-9a-f]{40}$/.test(base ?? '')) throw new Error('VALID_BASE_SHA_REQUIRED');
  const paths = full ? [] : execFileSync('git', ['diff', '--name-only', '-z', `${base}...HEAD`], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const scope = selectScope(paths, full);
  console.log(JSON.stringify(scope));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(scope).map(([key, value]) => `${key}=${value}\n`).join(''));
}
