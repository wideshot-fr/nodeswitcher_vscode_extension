import * as assert from 'assert';
import {
	collect_stable_semver_versions_from_text,
	sort_versions_semver_desc
} from '../version_utils';

suite('version_utils', () => {
	test('sort_versions_semver_desc orders newest first', () => {
		const out = sort_versions_semver_desc(['18.0.0', '20.10.0', '20.9.0', '22.1.0']);
		assert.deepStrictEqual(out, ['22.1.0', '20.10.0', '20.9.0', '18.0.0']);
	});

	test('collect_stable_semver_versions_from_text dedupes and filters prerelease', () => {
		const raw = `v20.10.0
  18.12.1
  20.10.0
  19.0.0-rc.1`;
		const out = collect_stable_semver_versions_from_text(raw);
		assert.ok(!out.some((v) => v.startsWith('19.0.0')));
		assert.ok(out.includes('20.10.0'));
		assert.ok(out.includes('18.12.1'));
		assert.strictEqual(out.length, 2);
	});
});
