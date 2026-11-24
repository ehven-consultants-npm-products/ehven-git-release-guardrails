import { fail } from '../errors.mjs';
import { normalizeRemoteUrl } from '../remote.mjs';
import { branch, fields, LIMITS, objectId } from '../validation.mjs';
import { GIT_LOCAL_ARGS, runBounded } from './process.mjs';

// Keep the accepted network syntax narrower than Git's general URL parser.
// SCP-style paths are relative on generic SSH servers. Keep that distinction.
const host = '[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?';
const user = '[a-zA-Z0-9_][a-zA-Z0-9._-]*';
const path = '[a-zA-Z0-9._-]+(?:/[a-zA-Z0-9._-]+)*';
const https = new RegExp(`^https://${host}(?::[0-9]+)?/${path}$`, 'u');
const ssh = new RegExp(`^ssh://${user}@${host}(?::[0-9]+)?/${path}$`, 'u');
const scp = new RegExp(`^(${user})@(${host}):(${path})$`, 'u');

function endpoint(value) {
  const normalized = normalizeRemoteUrl(value);
  if (https.test(value)) return { protocol: 'https', url: normalized };
  if (ssh.test(value)) return { protocol: 'ssh', url: normalized };
  const match = scp.exec(value);
  if (match && !match[3].startsWith('-')) {
    return { protocol: 'ssh', url: `${match[1]}@${match[2].toLowerCase()}:${match[3]}` };
  }
  fail('ERR_LIVE_REMOTE_URL', 'Use an explicit HTTPS or SSH endpoint with a simple host and repository path for live validation.');
}

export function readLiveAuthorization(value) {
  if (value === undefined) return undefined;
  const data = fields(value, ['endpoint', 'value'], 'HTTPS authorization');
  const target = endpoint(data.endpoint);
  if (target.protocol !== 'https' || typeof data.value !== 'string' || data.value.length > 8192
      || !/^(?:Bearer|Basic) [A-Za-z0-9._~+/=-]+$/u.test(data.value)) {
    fail('ERR_LIVE_AUTHORIZATION', 'Supply a Basic or Bearer authorization value for one approved HTTPS endpoint.');
  }
  return { endpoint: target.url, value: data.value };
}

function approvedDestinations(raw, approved, authorization) {
  const urls = new Set(approved.map(endpoint).map(entry => entry.url));
  const destinations = [
    { role: 'fetch', ...endpoint(raw.fetch) },
    { role: 'push', ...endpoint(raw.push) },
  ];
  if (destinations.some(destination => !urls.has(destination.url))) {
    fail('ERR_LIVE_REMOTE_URL', 'Each effective live endpoint must match an approved URL with the same path semantics.');
  }
  if (authorization && !destinations.some(destination => destination.protocol === 'https' && destination.url === authorization.endpoint)) {
    fail('ERR_LIVE_AUTHORIZATION', 'The authorization endpoint must match an effective approved HTTPS destination.');
  }
  return destinations;
}

function advertisedHeads(output, format) {
  if (output !== '' && !output.endsWith('\n')) fail('ERR_LIVE_REMOTE_REFS', 'Git returned incomplete remote ref output.');
  const heads = new Map();
  const lines = output === '' ? [] : output.slice(0, -1).split('\n');
  if (lines.length > LIMITS.refs) fail('ERR_LIVE_REMOTE_REFS', 'Remote branch count exceeds the supported limit.');
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length !== 2 || !parts[1].startsWith('refs/heads/')) fail('ERR_LIVE_REMOTE_REFS', 'Git returned unsupported remote ref output.');
    let name, oid;
    try {
      name = branch(parts[1].slice('refs/heads/'.length), 'Remote branch');
      oid = objectId(parts[0], format, 'Remote commit');
    } catch { fail('ERR_LIVE_REMOTE_REFS', 'Git returned an unsupported remote branch or object ID.'); }
    if (heads.has(name)) fail('ERR_LIVE_REMOTE_REFS', 'Git advertised a duplicate remote branch.');
    heads.set(name, oid);
  }
  return heads;
}

const SSH_COMMAND = [
  'ssh -F /dev/null', '-o BatchMode=yes', '-o StrictHostKeyChecking=yes',
  '-o UpdateHostKeys=no', '-o ClearAllForwardings=yes', '-o ForwardAgent=no',
  '-o ForwardX11=no', '-o PermitLocalCommand=no', '-o ControlMaster=no', '-o ControlPath=none',
].join(' ');

async function query(destination, format, authorization, options) {
  const { protocol, url, role } = destination;
  const transport = { protocol, authorization: url === authorization?.endpoint ? authorization.value : undefined };
  const args = [
    '--git-dir=/dev/null', ...GIT_LOCAL_ARGS, '-c', `protocol.${protocol}.allow=always`,
    '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true',
    '-c', 'ssh.variant=ssh', '-c', `core.sshCommand=${SSH_COMMAND}`,
    'ls-remote', '--refs', '--heads', '--', url,
  ];
  const result = await runBounded('git', args, { ...options, isolatedConfig: true, transport });
  if (result.status !== 0 || result.stderrBytes) {
    fail('ERR_LIVE_REMOTE_QUERY', `The ${role} endpoint did not return a clean read-only Git advertisement. Check access, TLS or SSH host trust, then retry.`);
  }
  return advertisedHeads(result.stdout, format);
}

export async function validateAdvertisements({ raw, approved, authorization, cached, format, options }) {
  const destinations = approvedDestinations(raw, approved, authorization);
  const observations = new Map();
  for (const destination of destinations) {
    if (observations.has(destination.url)) continue;
    const heads = await query(destination, format, authorization, options);
    const cachedEntries = Object.entries(cached);
    let missing = 0, moved = 0, added = 0;
    for (const [name, oid] of cachedEntries) {
      if (!heads.has(name)) missing++;
      else if (heads.get(name) !== oid) moved++;
    }
    for (const name of heads.keys()) if (!Object.hasOwn(cached, name)) added++;
    if (missing || moved || added) {
      fail('ERR_LIVE_REMOTE_STALE', `The ${destination.role} endpoint differs from local tracking refs (${added} added, ${missing} missing, ${moved} moved). Refresh deliberately and review again.`);
    }
    observations.set(destination.url, heads.size);
  }
  return {
    checkedAt: new Date().toISOString(),
    fetchBranchCount: observations.get(destinations[0].url),
    pushBranchCount: observations.get(destinations[1].url),
    distinctEndpointsChecked: observations.size,
  };
}
