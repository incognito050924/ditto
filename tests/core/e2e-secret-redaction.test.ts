import { describe, expect, test } from 'bun:test';
import {
  type RedactionRule,
  assertNoPlaintextSecret,
  redactForPlan,
} from '~/core/e2e/secret-redaction';

describe('redactForPlan', () => {
  test('masks a secret-var value → <env:VAR> and records a redaction', () => {
    const rule: RedactionRule = {
      secretVars: ['ADMIN_PASSWORD'],
      credentialRefs: [],
      envValues: { ADMIN_PASSWORD: 'hunter2secret' },
    };
    const { text, redactions } = redactForPlan(
      'Log in with password hunter2secret then continue',
      rule,
    );

    expect(text).toBe('Log in with password <env:ADMIN_PASSWORD> then continue');
    expect(text).not.toContain('hunter2secret');
    expect(redactions).toHaveLength(1);
    expect(redactions[0]).toEqual({
      field: 'ADMIN_PASSWORD',
      ref: '<env:ADMIN_PASSWORD>',
      location: 'Log in with password '.length,
    });
  });

  test('masks a value referenced via credentialRefs, preserving the scheme', () => {
    const rule: RedactionRule = {
      secretVars: [],
      credentialRefs: ['secret:API_KEY'],
      envValues: { API_KEY: 'sk-live-abc123' },
    };
    const { text, redactions } = redactForPlan('token=sk-live-abc123', rule);

    expect(text).toBe('token=<secret:API_KEY>');
    expect(redactions).toHaveLength(1);
    expect((redactions[0] as (typeof redactions)[number]).field).toBe('API_KEY');
    expect((redactions[0] as (typeof redactions)[number]).ref).toBe('<secret:API_KEY>');
  });

  test('non-secret text passes through unchanged', () => {
    const rule: RedactionRule = {
      secretVars: ['ADMIN_PASSWORD'],
      credentialRefs: ['env:ADMIN_TOKEN'],
      envValues: { ADMIN_PASSWORD: 'hunter2secret', ADMIN_TOKEN: 'tok-xyz' },
    };
    const input = 'Open the dashboard and click Save';
    const { text, redactions } = redactForPlan(input, rule);

    expect(text).toBe(input);
    expect(redactions).toEqual([]);
  });
});

describe('assertNoPlaintextSecret', () => {
  const rule: RedactionRule = {
    secretVars: ['ADMIN_PASSWORD'],
    credentialRefs: [],
    envValues: { ADMIN_PASSWORD: 'hunter2secret' },
  };

  test('throws when a known env value appears literally (fail-closed)', () => {
    expect(() => assertNoPlaintextSecret('password is hunter2secret', rule)).toThrow();
  });

  test('passes when only the placeholder is present', () => {
    expect(() => assertNoPlaintextSecret('password is <env:ADMIN_PASSWORD>', rule)).not.toThrow();
  });

  test('does not leak the secret value in the thrown error message', () => {
    let message = '';
    try {
      assertNoPlaintextSecret('password is hunter2secret', rule);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain('hunter2secret');
    expect(message).toContain('ADMIN_PASSWORD');
  });
});
