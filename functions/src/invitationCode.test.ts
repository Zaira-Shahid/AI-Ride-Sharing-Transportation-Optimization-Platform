import { describe, expect, it } from 'vitest';
import {
  generateInvitationCode,
  hashInvitationToken,
  parseInvitationCode,
  tokenMatchesHash,
} from './invitationCode';

const ID = 'AbCdEfGhIjKlMnOpQrSt';

describe('invitation codes', () => {
  it('generates a code that parses back, with a hash that matches only its own token', () => {
    const { code, tokenHash } = generateInvitationCode(ID);
    const parsed = parseInvitationCode(code);
    expect(parsed?.invitationId).toBe(ID);
    expect(tokenMatchesHash(parsed!.token, tokenHash)).toBe(true);
    expect(tokenMatchesHash(parsed!.token + 'x', tokenHash)).toBe(false);
    expect(tokenMatchesHash('a'.repeat(43), tokenHash)).toBe(false);
  });

  it('never stores or contains the token in the hash', () => {
    const { code, tokenHash } = generateInvitationCode(ID);
    const token = code.split('.')[1]!;
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token);
    expect(tokenHash).toBe(hashInvitationToken(token));
  });

  it('makes a different code every time', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateInvitationCode(ID).code));
    expect(codes.size).toBe(50);
  });

  it('trims surrounding whitespace, since codes are pasted from chat apps', () => {
    const { code } = generateInvitationCode(ID);
    expect(parseInvitationCode(`  ${code}\n`)?.invitationId).toBe(ID);
  });

  it.each([
    ['not a string', 42],
    ['null', null],
    ['empty', ''],
    ['no dot', ID],
    ['an empty token', `${ID}.`],
    ['an empty id', `.${'a'.repeat(43)}`],
    ['a short token', `${ID}.${'a'.repeat(42)}`],
    ['a long token', `${ID}.${'a'.repeat(44)}`],
    ['a token with a bad character', `${ID}.${'a'.repeat(42)}!`],
    ['an id with a bad character', `${ID}/.${'a'.repeat(43)}`],
    ['a short id', `abc.${'a'.repeat(43)}`],
    ['an extra part', `${ID}.${'a'.repeat(43)}.x`],
  ])('rejects %s', (_name, value) => {
    expect(parseInvitationCode(value)).toBeNull();
  });

  it('does not match a missing or non-string stored hash', () => {
    expect(tokenMatchesHash('a'.repeat(43), undefined)).toBe(false);
    expect(tokenMatchesHash('a'.repeat(43), 7)).toBe(false);
    expect(tokenMatchesHash('a'.repeat(43), '')).toBe(false);
  });
});
