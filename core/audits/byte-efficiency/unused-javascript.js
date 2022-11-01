/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

import {Audit} from '../audit.js';
import {ByteEfficiencyAudit} from './byte-efficiency-audit.js';
import {EntityClassification} from '../../computed/entity-classification.js';
import {UnusedJavascriptSummary} from '../../computed/unused-javascript-summary.js';
import {JSBundles} from '../../computed/js-bundles.js';
import * as i18n from '../../lib/i18n/i18n.js';
import {getRequestForScript} from '../../lib/script-helpers.js';

const UIStrings = {
  /** Imperative title of a Lighthouse audit that tells the user to reduce JavaScript that is never evaluated during page load. This is displayed in a list of audit titles that Lighthouse generates. */
  title: 'Reduce unused JavaScript',
  /** Description of a Lighthouse audit that tells the user *why* they should reduce JavaScript that is never needed/evaluated by the browser. This is displayed after a user expands the section to see more. No character length limits. The last sentence starting with 'Learn' becomes link text to additional documentation. */
  description: 'Reduce unused JavaScript and defer loading scripts until they are required to ' +
    'decrease bytes consumed by network activity. [Learn how to reduce unused JavaScript](https://web.dev/unused-javascript/).',
};

const str_ = i18n.createIcuMessageFn(import.meta.url, UIStrings);

const UNUSED_BYTES_IGNORE_THRESHOLD = 20 * 1024;
const UNUSED_BYTES_IGNORE_BUNDLE_SOURCE_THRESHOLD = 512;

/**
 * @param {string[]} strings
 */
function commonPrefix(strings) {
  if (!strings.length) {
    return '';
  }

  const maxWord = strings.reduce((a, b) => a > b ? a : b);
  let prefix = strings.reduce((a, b) => a > b ? b : a);
  while (!maxWord.startsWith(prefix)) {
    prefix = prefix.slice(0, -1);
  }

  return prefix;
}

/**
 * @param {string} string
 * @param {string} commonPrefix
 * @return {string}
 */
function trimCommonPrefix(string, commonPrefix) {
  if (!commonPrefix) return string;
  return string.startsWith(commonPrefix) ? '…' + string.slice(commonPrefix.length) : string;
}

/**
 * @typedef WasteData
 * @property {Uint8Array} unusedByIndex
 * @property {number} unusedLength
 * @property {number} contentLength
 */

class UnusedJavaScript extends ByteEfficiencyAudit {
  /**
   * @return {LH.Audit.Meta}
   */
  static get meta() {
    return {
      id: 'unused-javascript',
      title: str_(UIStrings.title),
      description: str_(UIStrings.description),
      scoreDisplayMode: ByteEfficiencyAudit.SCORING_MODES.NUMERIC,
      requiredArtifacts: ['JsUsage', 'Scripts', 'SourceMaps', 'GatherContext',
        'devtoolsLogs', 'traces', 'URL'],
    };
  }

  /**
   * @param {LH.Artifacts} artifacts
   * @param {Array<LH.Artifacts.NetworkRequest>} networkRecords
   * @param {LH.Audit.Context} context
   * @return {Promise<import('./byte-efficiency-audit.js').ByteEfficiencyProduct>}
   */
  static async audit_(artifacts, networkRecords, context) {
    const bundles = await JSBundles.request(artifacts, context);
    const devtoolsLog = artifacts.devtoolsLogs[Audit.DEFAULT_PASS];
    const classifiedEntities = await EntityClassification.request(
      {URL: artifacts.URL, devtoolsLog}, context);
    const {
      unusedThreshold = UNUSED_BYTES_IGNORE_THRESHOLD,
      bundleSourceUnusedThreshold = UNUSED_BYTES_IGNORE_BUNDLE_SOURCE_THRESHOLD,
    } = context.options || {};

    /** @type {Map<LH.Artifacts.RecognizableEntity | undefined, LH.Audit.Details.OpportunityGroupItem>} */
    const byEntity = new Map();
    const items = [];
    for (const [scriptId, scriptCoverage] of Object.entries(artifacts.JsUsage)) {
      const script = artifacts.Scripts.find(s => s.scriptId === scriptId);
      if (!script) continue; // This should never happen.

      const networkRecord = getRequestForScript(networkRecords, script);
      if (!networkRecord) continue;

      const bundle = bundles.find(b => b.script.scriptId === scriptId);
      const unusedJsSummary =
        await UnusedJavascriptSummary.request({scriptId, scriptCoverage, bundle}, context);
      if (unusedJsSummary.wastedBytes === 0 || unusedJsSummary.totalBytes === 0) continue;

      const transfer = ByteEfficiencyAudit
        .estimateTransferSize(networkRecord, unusedJsSummary.totalBytes, 'Script');
      const transferRatio = transfer / unusedJsSummary.totalBytes;
      const classifiedEntity = classifiedEntities.byURL.get(script.url);
      /** @type {LH.Audit.ByteEfficiencyItem} */
      const item = {
        url: script.url,
        totalBytes: Math.round(transferRatio * unusedJsSummary.totalBytes),
        wastedBytes: Math.round(transferRatio * unusedJsSummary.wastedBytes),
        wastedPercent: unusedJsSummary.wastedPercent,
        entity: classifiedEntity?.name,
      };

      if (item.wastedBytes <= unusedThreshold) continue;
      items.push(item);

      // Which entity group would this item fall into?
      const entityGroup = byEntity.get(classifiedEntity) || {
        url: {
          text: classifiedEntity?.name || '',
          type: 'link',
          url: classifiedEntity?.homepage || '#',
        },
        groupBy: 'entity',
        entity: classifiedEntity?.name || '',
        wastedBytes: 0,
        totalBytes: 0,
      };
      entityGroup.totalBytes = (entityGroup.totalBytes || 0) + item.totalBytes;
      entityGroup.wastedBytes = (entityGroup.wastedBytes || 0) + item.wastedBytes;
      entityGroup.wastedPercent = entityGroup.wastedBytes / entityGroup.totalBytes * 100;
      byEntity.set(classifiedEntity, entityGroup);

      // If there was an error calculating the bundle sizes, we can't
      // create any sub-items.
      if (!bundle || 'errorMessage' in bundle.sizes) continue;
      const sizes = bundle.sizes;

      // Augment with bundle data.
      if (unusedJsSummary.sourcesWastedBytes) {
        const topUnusedSourceSizes = Object.entries(unusedJsSummary.sourcesWastedBytes)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([source, unused]) => {
            const total = source === '(unmapped)' ? sizes.unmappedBytes : sizes.files[source];
            return {
              source,
              unused: Math.round(unused * transferRatio),
              total: Math.round(total * transferRatio),
            };
          })
          .filter(d => d.unused >= bundleSourceUnusedThreshold);

        const commonSourcePrefix = commonPrefix(bundle.map.sourceURLs());
        item.subItems = {
          type: 'subitems',
          items: topUnusedSourceSizes.map(({source, unused, total}) => {
            return {
              source: trimCommonPrefix(source, commonSourcePrefix),
              sourceBytes: total,
              sourceWastedBytes: unused,
            };
          }),
        };
      }
    }

    // We group by entities that wasted most number of absolute bytes (and not %).
    const groups = [...byEntity.values()];

    return {
      items,
      groups,
      headings: [
        /* eslint-disable max-len */
        {key: 'url', valueType: 'url', subItemsHeading: {key: 'source', valueType: 'code'}, label: str_(i18n.UIStrings.columnURL)},
        {key: 'totalBytes', valueType: 'bytes', subItemsHeading: {key: 'sourceBytes'}, label: str_(i18n.UIStrings.columnTransferSize)},
        {key: 'wastedBytes', valueType: 'bytes', subItemsHeading: {key: 'sourceWastedBytes'}, label: str_(i18n.UIStrings.columnWastedBytes)},
        /* eslint-enable max-len */
      ],
    };
  }
}

export default UnusedJavaScript;
export {UIStrings};
