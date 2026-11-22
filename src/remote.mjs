import { fail } from './errors.mjs';
import { fields, list, text } from './validation.mjs';

/** Normalize endpoint syntax, not repository identity across different transports. */
export function normalizeRemoteUrl(input) {
  text(input, 'Remote URL', 4096);
  if (/[\\\s?#]/u.test(input)) fail('ERR_REMOTE_URL', 'Use an explicit credential-free HTTPS or SSH endpoint.');
  let source = input;
  if (!source.includes('://')) {
    const scp = /^([a-zA-Z0-9._-]+)@([a-zA-Z0-9.-]+):(.+)$/u.exec(source);
    if (!scp) fail('ERR_REMOTE_URL', 'Use an explicit credential-free HTTPS or SSH endpoint.');
    source = `ssh://${scp[1]}@${scp[2]}/${scp[3]}`;
  }
  // Refuse path aliases before URL parsing can erase dot segments.
  const path = source.match(/^[a-z]+:\/\/[^/]+(\/.*)$/iu)?.[1];
  if (!path || path === '/') fail('ERR_REMOTE_URL', 'The endpoint must identify a repository path.');
  for (const part of path.slice(1).split('/')) {
    let decoded;
    try { decoded = decodeURIComponent(part); } catch { fail('ERR_REMOTE_URL', 'Malformed remote URL encoding.'); }
    if (!part || decoded === '.' || decoded === '..' || /[\/\\\u0000-\u0020\u007f?#]/u.test(decoded)) {
      fail('ERR_REMOTE_URL', 'Ambiguous remote path components are unsupported.');
    }
  }
  let url;
  try { url = new URL(source); } catch { fail('ERR_REMOTE_URL', 'Malformed remote endpoint.'); }
  if (!['https:', 'ssh:'].includes(url.protocol) || !url.hostname || url.password || url.search || url.hash
      || (url.protocol === 'https:' && url.username)
      || (url.protocol === 'ssh:' && url.username && !/^[a-zA-Z0-9._-]+$/u.test(url.username))) {
    fail('ERR_REMOTE_URL', 'Use an explicit credential-free HTTPS or SSH endpoint.');
  }
  url.hostname = url.hostname.toLowerCase();
  if (url.protocol === 'ssh:' && url.port === '22') url.port = '';
  return url.href;
}

/** All effective destinations must match intentionally configured endpoints. */
export function assertRemoteDestinations(input) {
  const options = fields(input, ['expectedRemoteUrls', 'fetchUrls', 'pushUrls'], 'Remote destination options');
  const allowed = list(options.expectedRemoteUrls, 'Expected remote URLs', 8).map(normalizeRemoteUrl);
  if (!allowed.length || new Set(allowed).size !== allowed.length) fail('ERR_INPUT', 'Supply distinct approved remote endpoints.');
  const fetch = list(options.fetchUrls, 'Effective fetch URLs', 8).map(normalizeRemoteUrl);
  const push = list(options.pushUrls, 'Effective push URLs', 8).map(normalizeRemoteUrl);
  if (fetch.length !== 1 || push.length !== 1) fail('ERR_REMOTE_DESTINATION', 'Require exactly one effective fetch and one effective push destination.');
  if (!allowed.includes(fetch[0]) || !allowed.includes(push[0])) fail('ERR_REMOTE_DESTINATION', 'An effective remote destination differs from the approved endpoints.');
  return { fetchUrl: fetch[0], pushUrl: push[0] };
}
