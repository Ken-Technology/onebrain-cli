import { chmodSync, existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig, writeConfig } from '../src/config.ts';
import { createCredentialStore, refreshLogin, type StoredLogin } from '../src/credentials.ts';
import { fakeFetch } from './helpers.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'onebrain-cred-'));
const login: StoredLogin = {
  url: 'http://localhost:8787',
  issuer: 'https://issuer.test',
  clientId: 'cli',
  audience: null,
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

function fakeHelper(name: string): string {
  const bin = temp();
  writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, name), 0o755);
  return bin;
}

describe('config', () => {
  it('merges and reads settings', () => {
    const home = temp();
    expect(readConfig(home)).toEqual({});
    writeConfig(home, { url: 'https://brain.test' });
    writeConfig(home, { workspace: 'kenso' });
    expect(readConfig(home)).toEqual({ url: 'https://brain.test', workspace: 'kenso' });
  });
});

describe('credential store', () => {
  it('falls back to a mode 600 file when no keychain helper is on PATH', async () => {
    const home = temp();
    const store = createCredentialStore({ home, env: { PATH: '' }, platform: 'linux' });
    expect(await store.save(login)).toBe('file');
    const file = join(home, '.config/onebrain/credentials.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await store.load('http://localhost:8787/')).toEqual(login);
  });

  it('uses secret-tool on Linux and keeps no file copy', async () => {
    const home = temp();
    const calls: { command: string; args: string[]; input?: string }[] = [];
    let saved = '';
    const store = createCredentialStore({
      home,
      env: { PATH: fakeHelper('secret-tool') },
      platform: 'linux',
      run: (command, args, input) => {
        calls.push({ command, args, ...(input === undefined ? {} : { input }) });
        if (args[0] === 'store') saved = input ?? '';
        return { status: 0, stdout: args[0] === 'lookup' ? saved : '' };
      },
    });
    expect(await store.save(login)).toBe('keychain');
    expect(calls[0]?.args).toEqual([
      'store',
      '--label=One Brain',
      'service',
      'onebrain',
      'account',
      'http://localhost:8787',
    ]);
    expect(calls[0]?.args.join(' ')).not.toContain('at-1');
    expect(existsSync(join(home, '.config/onebrain/credentials.json'))).toBe(false);
    expect(await store.load(login.url)).toEqual(login);
  });

  it('falls back to the file when the helper fails', async () => {
    const home = temp();
    const store = createCredentialStore({
      home,
      env: { PATH: fakeHelper('secret-tool') },
      platform: 'linux',
      run: () => ({ status: 1, stdout: '' }),
    });
    expect(await store.save(login)).toBe('file');
  });
});

describe('refreshLogin', () => {
  it('trades the refresh token for a new access token', async () => {
    const fetchFn = fakeFetch({
      'GET /.well-known/openid-configuration': () => ({
        body: { token_endpoint: 'https://issuer.test/oauth/token' },
      }),
      'POST /oauth/token': (call) => {
        const form = new URLSearchParams(call.body as string);
        expect(form.get('grant_type')).toBe('refresh_token');
        expect(form.get('refresh_token')).toBe('rt-1');
        return { body: { access_token: 'at-2', expires_in: 600 } };
      },
    });
    const next = await refreshLogin(login, fetchFn);
    expect(next?.accessToken).toBe('at-2');
    expect(next?.refreshToken).toBe('rt-1');
  });

  it('returns null without a refresh token', async () => {
    expect(await refreshLogin({ ...login, refreshToken: null }, fakeFetch({}))).toBeNull();
  });
});
