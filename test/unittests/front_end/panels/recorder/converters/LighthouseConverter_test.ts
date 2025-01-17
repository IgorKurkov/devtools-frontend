// Copyright 2023 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

const {assert} = chai;

import * as Models from '../../../../../../front_end/panels/recorder/models/models.js';
import * as Converters from '../../../../../../front_end/panels/recorder/converters/converters.js';

describe('LighthouseConverter', () => {
  it('should stringify a flow', async () => {
    const converter = new Converters.LighthouseConverter.LighthouseConverter(
        '  ',
    );
    const [result, sourceMap] = await converter.stringify({
      title: 'test',
      steps: [
        {type: Models.Schema.StepType.Navigate, url: 'https://example.com'},
        {type: Models.Schema.StepType.Scroll, selectors: [['.cls']]},
      ],
    });
    assert.isTrue(
        result.startsWith(`const fs = require('fs');
const puppeteer = require('puppeteer'); // v13.0.0 or later

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  const timeout = 5000;
  page.setDefaultTimeout(timeout);

  const lhApi = await import('lighthouse'); // v10.0.0 or later
  const flags = {
    screenEmulation: {
      disabled: true
    }
  }
  const config = lhApi.desktopConfig;
  const lhFlow = await lhApi.startFlow(page, {name: 'test', config, flags});
  await lhFlow.startNavigation();
  {
    const targetPage = page;
    await targetPage.goto('https://example.com');
  }
  await lhFlow.endNavigation();
  await lhFlow.startTimespan();
  {
    const targetPage = page;
    await scrollIntoViewIfNeeded([
      [
        '.cls'
      ]
    ], targetPage, timeout);
    const element = await waitForSelectors([
      [
        '.cls'
      ]
    ], targetPage, { timeout, visible: true });
    await element.evaluate((el, x, y) => { el.scrollTop = y; el.scrollLeft = x; }, undefined, undefined);
  }
  await lhFlow.endTimespan();
  const lhFlowReport = await lhFlow.generateReport();
  fs.writeFileSync(__dirname + '/flow.report.html', lhFlowReport)

  await browser.close();`),
    );
    assert.deepStrictEqual(sourceMap, [1, 17, 6, 23, 15]);
  });

  it('should stringify a step', async () => {
    const converter = new Converters.LighthouseConverter.LighthouseConverter(
        '  ',
    );
    const result = await converter.stringifyStep({
      type: Models.Schema.StepType.Scroll,
    });
    assert.strictEqual(
        result,
        `{
  const targetPage = page;
  await targetPage.evaluate((x, y) => { window.scroll(x, y); }, undefined, undefined)
}
`,
    );
  });
});
