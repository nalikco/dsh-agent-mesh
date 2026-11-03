import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const json = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

test('Russian metadata matches English fields and is exported for distribution', async () => {
  const en = await json('../locale/en.json');
  const ru = await json('../locale/ru.json');
  const pkg = await json('../package.json');
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
  assert.deepEqual(Object.keys(ru.meta).sort(), Object.keys(en.meta).sort());
  for (const value of Object.values(ru.meta)) assert.ok(value.trim().length > 0);
  assert.match(ru.meta.description, /[А-Яа-яЁё]/u);
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.ok(pkg.files.includes('locale/*.json'));
});
