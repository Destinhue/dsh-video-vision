import test from 'node:test';
import assert from 'node:assert/strict';
import { storyboardSpec, zoomSpec } from '../src/tools.js';

test('dedupe is a storyboard choice, spelled out in the schema', () => {
  const spec = storyboardSpec({});
  const param = spec.parameters.properties.dedupe;
  assert.ok(param, 'storyboard exposes dedupe');
  assert.equal(param.type, 'string');
  assert.deepEqual(param.enum, ['shots', 'global']);
  assert.match(param.description, /slide deck/);
  assert.match(param.description, /collapse|fold|same picture|already have/);
  // the default is per shot: nothing in the schema may default to global
  assert.equal(param.default, undefined);
});

test('zoom keeps every cell it was asked for', () => {
  assert.equal(zoomSpec({}).parameters.properties.dedupe, undefined);
});
