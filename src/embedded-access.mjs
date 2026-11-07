import { timingSafeEqual } from 'node:crypto';

// A host application authenticates users and supplies an opaque, session-bound
// scope. Standalone deployments continue to use their existing access boundary.
export function embeddedScope(headers, token) {
  if (!token) return '';
  const actual = headers['x-xycad-host-token'];
  const scope = headers['x-xycad-scope'];
  if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual) || actual.length !== token.length ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(token)) ||
      typeof scope !== 'string' || !/^[a-f0-9]{64}$/.test(scope)) return null;
  return scope;
}
