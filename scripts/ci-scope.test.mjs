import test from 'node:test';
import assert from 'node:assert/strict';
import { selectScope } from './ci-scope.mjs';

test('docs-only changes do not trigger component suites', () => {
  assert.deepEqual(selectScope(['qa.md']), { server: false, web: false, driver: false, site: false, admin: false, code: false });
});
test('client changes select their own suites', () => {
  assert.deepEqual(selectScope(['apps/web/src/router.tsx']), { server: false, web: true, driver: false, site: false, admin: false, code: true });
  assert.deepEqual(selectScope(['apps/driver/app/index.tsx']), { server: false, web: false, driver: true, site: false, admin: false, code: true });
  assert.deepEqual(selectScope(['apps/site/src/main.tsx']), { server: false, web: false, driver: false, site: true, admin: false, code: true });
  assert.deepEqual(selectScope(['apps/admin/src/main.mjs']), { server: false, web: false, driver: false, site: false, admin: true, code: true });
});
test('shared, unknown and workflow changes invalidate all consumers', () => {
  for (const path of ['packages/api-contracts/src/api.ts', 'package-lock.json', '.github/workflows/ci.yml', 'new-code.js']) {
    assert.deepEqual(selectScope([path]), { server: true, web: true, driver: true, site: true, admin: true, code: true });
  }
});
test('release validation always selects every component', () => {
  assert.deepEqual(selectScope([], true), { server: true, web: true, driver: true, site: true, admin: true, code: true });
});
