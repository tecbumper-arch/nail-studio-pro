import { describe, it, expect } from 'vitest';
import { signToken, verifyToken } from '../src/session.js';

const SECRET = 'test-secret';
const DAY = 86400;

describe('session tokens', () => {
  it('signs and verifies a studio token', async () => {
    const now = 1_700_000_000_000;
    const t = await signToken({ kind: 'studio', sid: 'S1', email: 'a@b.com' }, SECRET, 30 * DAY, now);
    expect(t.startsWith('v1.')).toBe(true);
    const p = await verifyToken(t, SECRET, now + 1000);
    expect(p).toMatchObject({ kind: 'studio', sid: 'S1', email: 'a@b.com' });
    expect(typeof p.exp).toBe('number');
  });

  it('rejects a token with one changed character', async () => {
    const t = await signToken({ kind: 'studio', sid: 'S1' }, SECRET, DAY);
    for (const i of [t.indexOf('.') + 3, t.length - 2]) {
      const c = t[i] === 'A' ? 'B' : 'A';
      expect(await verifyToken(t.slice(0, i) + c + t.slice(i + 1), SECRET)).toBeNull();
    }
  });

  it('rejects an expired token', async () => {
    const now = 1_700_000_000_000;
    const t = await signToken({ kind: 'studio', sid: 'S1' }, SECRET, 30 * DAY, now);
    expect(await verifyToken(t, SECRET, now + 31 * DAY * 1000)).toBeNull();
  });

  it('rejects a token signed with another secret', async () => {
    const t = await signToken({ kind: 'studio', sid: 'S1' }, SECRET, DAY);
    expect(await verifyToken(t, 'other-secret')).toBeNull();
  });

  it('rejects garbage', async () => {
    expect(await verifyToken('abc', SECRET)).toBeNull();
    expect(await verifyToken('', SECRET)).toBeNull();
    expect(await verifyToken(undefined, SECRET)).toBeNull();
    expect(await verifyToken('v1.x.y', SECRET)).toBeNull();
  });
});
