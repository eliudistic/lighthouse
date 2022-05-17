/**
 * @license Copyright 2016 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

import {strict as assert} from 'assert';

import pwaTrace from '../fixtures/traces/progressive-app.json';
import threeFrameTrace from '../fixtures/traces/threeframes-blank_content_more.json';
import Speedline from '../../computed/speedline.js';
import {readJson} from '../../../root.js';

describe('Speedline gatherer', () => {
  it('returns an error message on faulty trace data', async () => {
    const context = {computedCache: new Map()};

    try {
      const _ = await Speedline.request({traceEvents: {boo: 'ya'}}, context);
      assert.fail(true, true, 'Invalid trace did not throw exception in speedline');
    } catch (err) {
      assert.ok(err);
      assert.ok(err.message.length);
    }
  });

  it('throws when no frames', async () => {
    const traceWithNoFrames = pwaTrace.filter(evt => evt.name !== 'Screenshot');
    const context = {computedCache: new Map()};

    try {
      const _ = await Speedline.request({traceEvents: traceWithNoFrames}, context);
      assert.ok(false, 'Invalid trace did not throw exception in speedline');
    } catch (err) {
      assert.equal(err.message, 'NO_SCREENSHOTS');
    }
  });

  it('measures the pwa.rocks example', async () => {
    const context = {computedCache: new Map()};
    const speedline = await Speedline.request({traceEvents: pwaTrace}, context);
    assert.equal(speedline.perceptualSpeedIndex, undefined);
    assert.equal(Math.floor(speedline.speedIndex), 549);
  }, 10000);

  it('measures SI of 3 frame trace (blank @1s, content @2s, more content @3s)', async () => {
    const context = {computedCache: new Map()};
    const speedline = await Speedline.request(threeFrameTrace, context);
    assert.equal(speedline.perceptualSpeedIndex, undefined);
    assert.equal(Math.floor(speedline.speedIndex), 2040);
  }, 10000);

  it('does not change order of events in traces', async () => {
    // Use fresh trace in case it has been altered by other require()s.
    const pwaTrace = readJson('lighthouse-core/test/fixtures/traces/progressive-app.json');
    const context = {computedCache: new Map()};
    const _ = await Speedline.request({traceEvents: pwaTrace}, context);
    // assert.deepEqual has issue with diffing large array, so manually loop.
    const freshTrace = readJson('lighthouse-core/test/fixtures/traces/progressive-app.json');
    assert.strictEqual(pwaTrace.length, freshTrace.length);
    for (let i = 0; i < pwaTrace.length; i++) {
      assert.deepStrictEqual(pwaTrace[i], freshTrace[i]);
    }
  }, 10000);
});
