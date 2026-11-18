import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createGoogle, resetGoogleTokenCache } from '../src/google.js';
import { GoogleError, UserError } from '../src/errors.js';
import { createFakeGoogle } from './fakeGoogle.js';

const env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'rt', GOOGLE_API_BASE: 'http://fake' };
const tokenCalls = (fake) => fake.calls.filter((c) => c.path === '/token').length;

beforeEach(() => { resetGoogleTokenCache(); vi.useRealTimers(); });

describe('google client', () => {
  it('caches the access token until 60s before expiry', async () => {
    const fake = createFakeGoogle({ S1: { A: [['x']] } });
    const g = createGoogle(env, fake.fetch);
    await g.readTab('S1', 'A');
    await g.readTab('S1', 'A');
    expect(tokenCalls(fake)).toBe(1);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + (3600 - 59) * 1000);
    await g.readTab('S1', 'A');
    expect(tokenCalls(fake)).toBe(2);
  });

  it('readTab returns [] for a missing tab', async () => {
    const fake = createFakeGoogle({ S1: {} });
    expect(await createGoogle(env, fake.fetch).readTab('S1', 'Nope')).toEqual([]);
  });

  it('writeTab replaces all rows', async () => {
    const fake = createFakeGoogle({ S1: { A: [['old'], ['old2']] } });
    const g = createGoogle(env, fake.fetch);
    await g.writeTab('S1', 'A', [['h'], ['1']]);
    expect(fake.db.S1.A).toEqual([['h'], ['1']]);
    expect(await g.readTab('S1', 'A')).toEqual([['h'], ['1']]);
  });

  it('appendRow adds one row', async () => {
    const fake = createFakeGoogle({ S1: { A: [['h']] } });
    const g = createGoogle(env, fake.fetch);
    await g.appendRow('S1', 'A', ['a', 'b']);
    expect(fake.db.S1.A).toEqual([['h'], ['a', 'b']]);
  });

  it('non-2xx from Sheets throws GoogleError with status', async () => {
    const fake = createFakeGoogle({ S1: { A: [] } });
    const g = createGoogle(env, fake.fetch);
    fake.fail(429, /\/v4\//);
    const err = await g.readTab('S1', 'A').catch((e) => e);
    expect(err).toBeInstanceOf(GoogleError);
    expect(err.status).toBe(429);
  });

  it('userEmail rejects an unverified email', async () => {
    const fake = createFakeGoogle({}, { userinfo: { email: 'a@b.com', verified_email: false, name: 'A' } });
    await expect(createGoogle(env, fake.fetch).userEmail('tok')).rejects.toBeInstanceOf(UserError);
  });

  it('userEmail returns lowercased email and name when verified', async () => {
    const fake = createFakeGoogle();
    expect(await createGoogle(env, fake.fetch).userEmail('tok')).toEqual({ email: 'fake@example.com', name: 'Fake User' });
  });

  it('createSpreadsheet, shareWithOwner and calendar calls work', async () => {
    const fake = createFakeGoogle();
    const g = createGoogle(env, fake.fetch);
    const id = await g.createSpreadsheet('T', ['A', 'B']);
    expect(fake.db[id]).toEqual({ A: [], B: [] });
    expect(await g.shareWithOwner(id, 'x@y.com')).toBe('PROPRIETARIA');
    const tok = await g.calendarAccessToken('rt2');
    const ev = await g.createCalendarEvent(tok, { summary: 's' });
    expect(ev).toMatch(/fake-event/);
    await g.deleteCalendarEvent(tok, ev);
    const ex = await g.exchangeCode('c1', 'http://r');
    expect(ex.refresh_token).toBe('fake-refresh');
  });

  it('shareWithOwner reports pending owner and plain share', async () => {
    const f1 = createFakeGoogle({}, { ownership: 'pending' });
    expect(await createGoogle(env, f1.fetch).shareWithOwner('s', 'x@y.com')).toBe('AGUARDANDO_ACEITE');
    const f2 = createFakeGoogle({}, { ownership: 'none' });
    expect(await createGoogle(env, f2.fetch).shareWithOwner('s', 'x@y.com')).toBe('COMPARTILHADA');
  });

  it('driveFilePermissions lists e-mail and role of a file', async () => {
    const perms = [{ emailAddress: 'a@x.com', role: 'owner' }, { emailAddress: 'b@x.com', role: 'writer' }];
    const fake = createFakeGoogle({}, { permissions: { F1: perms } });
    const g = createGoogle(env, fake.fetch);
    expect(await g.driveFilePermissions('F1')).toEqual(perms);
    const call = fake.calls.find((c) => c.path === '/drive/v3/files/F1/permissions');
    expect(call.method).toBe('GET');
    expect(new URLSearchParams(call.query).get('fields')).toBe('permissions(emailAddress,role)');
    await expect(g.driveFilePermissions('NOPE')).rejects.toBeInstanceOf(GoogleError);
  });

  it('serviceAccountEmail reads the Drive user of the server account', async () => {
    const fake = createFakeGoogle({}, { serviceEmail: 'motor@x.com' });
    const g = createGoogle(env, fake.fetch);
    expect(await g.serviceAccountEmail()).toBe('motor@x.com');
    const call = fake.calls.find((c) => c.path === '/drive/v3/about');
    expect(new URLSearchParams(call.query).get('fields')).toBe('user(emailAddress)');
    fake.fail(500, /about/);
    await expect(g.serviceAccountEmail()).rejects.toBeInstanceOf(GoogleError);
  });
});
