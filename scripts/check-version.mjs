// Checks that a release tag matches the "version" of package.json, so the card published by
// .github/workflows/release.yml logs the same version in its console banner as the release HACS
// shows (the banner reads package.json at build time, HACS reads the tag).
//
//   node scripts/check-version.mjs v0.1.0        # or 0.1.0
//   RELEASE_TAG=v0.1.0 node scripts/check-version.mjs
//
// The tag is the first argument, else $RELEASE_TAG, else $GITHUB_REF_NAME. Accepted forms:
// "vX.Y.Z" or "X.Y.Z" (a semver pre-release suffix such as "-beta.1" is allowed and must match
// too). Exit code 0 when the tag equals the version, 1 otherwise (with a message saying what to
// change). In GitHub Actions the failure is also printed as an ::error:: annotation.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TAG_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

function fail(message) {
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error title=Version check::${message}`);
  console.error(`check-version: ${message}`);
  process.exit(1);
}

const tag = (
  process.argv[2] ??
  process.env.RELEASE_TAG ??
  process.env.GITHUB_REF_NAME ??
  ''
).trim();
if (tag === '') {
  fail('no tag given: pass it as the first argument (e.g. "v0.1.0") or set RELEASE_TAG.');
}

const match = TAG_RE.exec(tag);
if (!match) {
  fail(`tag "${tag}" is not a version tag: expected "vX.Y.Z" or "X.Y.Z" (e.g. "v1.2.3").`);
}

let version;
try {
  ({ version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
} catch (error) {
  fail(`cannot read the version of package.json: ${String(error)}`);
}
if (typeof version !== 'string' || version === '') {
  fail('package.json has no "version" field.');
}

if (match[1] !== version) {
  fail(
    `tag "${tag}" does not match package.json version "${version}". ` +
      `Either set "version" to "${match[1]}" in package.json (npm version ${match[1]} --no-git-tag-version), ` +
      `commit, and tag that commit, or delete this tag (git push --delete origin ${tag}) and tag ` +
      `the commit "v${version}". The release workflow stops here: it publishes nothing.`,
  );
}

console.log(`check-version: tag "${tag}" matches package.json version ${version}.`);
