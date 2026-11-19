import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { hashPin } from '../src/util.js';

const salted = (s) => createHash('sha256').update('NAIL_STUDIO_PRO_SALT_2026_' + s).digest('hex');

describe('hashPin', () => {
  it('uses the original app scheme: sha256(salt + trimmed lowercase PIN)', async () => {
    expect(await hashPin('2580')).toBe(salted('2580'));
    expect(await hashPin(' 2580 ')).toBe(salted('2580'));
    expect(await hashPin('AbC1')).toBe(salted('abc1'));
    expect(await hashPin(123456)).toBe(salted('123456'));
  });
});
