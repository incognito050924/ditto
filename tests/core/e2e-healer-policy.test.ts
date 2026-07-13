import { describe, expect, test } from 'bun:test';
import { filterHealPatch } from '~/core/e2e/healer-policy';

/**
 * ac-7: the HARD mechanical heal filter (Contract 5-A).
 *
 * Independent of agent obedience, filterHealPatch must let ONLY selector/wait
 * repairs through and reject any hunk that touches an expected value
 * (`expect(`/`toHave`/`toContain`), a skip/fixme/only, a URL literal, or seed
 * data. This is what preserves ADR-0014 D4: a heal can never silently rewrite
 * what a test asserts — only `allowed` may be applied.
 */

describe('filterHealPatch', () => {
  test('mixed diff: getByRole hunk allowed, expect().toContainText hunk rejected', () => {
    const diff = [
      'diff --git a/e2e/generated/login.spec.ts b/e2e/generated/login.spec.ts',
      '--- a/e2e/generated/login.spec.ts',
      '+++ b/e2e/generated/login.spec.ts',
      "@@ -10,5 +10,5 @@ test('login', async ({ page }) => {",
      '   // @step jrn-login/s2 로그인 버튼 클릭',
      "-  await page.getByRole('button', { name: 'Sign in' }).click();",
      "+  await page.getByRole('button', { name: 'Log in' }).click();",
      "@@ -20,5 +20,5 @@ test('login', async ({ page }) => {",
      '   // @step jrn-login/s4 환영 메시지 확인',
      "-  await expect(page.getByText('welcome')).toContainText('Welcome back');",
      "+  await expect(page.getByText('welcome')).toContainText('Hello');",
    ].join('\n');

    const result = filterHealPatch(diff);

    // the selector repair survives
    expect(result.allowed).toContain("name: 'Log in'");
    // the assertion rewrite never enters the applied patch
    expect(result.allowed).not.toContain('toContainText');
    // exactly the assertion hunk is rejected, with a reason naming the forbidden token
    expect(result.rejected).toHaveLength(1);
    expect((result.rejected[0] as (typeof result.rejected)[number]).text).toContain(
      'toContainText',
    );
    expect(
      (result.rejected[0] as (typeof result.rejected)[number]).reasons.some(
        (r) => r.includes('expect') || r.includes('toContain'),
      ),
    ).toBe(true);
  });

  test('rejects a hunk that skips or fixmes a test', () => {
    const skipDiff = [
      '--- a/e2e/generated/x.spec.ts',
      '+++ b/e2e/generated/x.spec.ts',
      '@@ -1,3 +1,3 @@',
      "-test('flaky', async ({ page }) => {",
      "+test.skip('flaky', async ({ page }) => {",
    ].join('\n');
    const skipResult = filterHealPatch(skipDiff);
    expect(skipResult.allowed).toBe('');
    expect(skipResult.rejected).toHaveLength(1);
    expect(
      (skipResult.rejected[0] as (typeof skipResult.rejected)[number]).reasons.some((r) =>
        r.includes('skip'),
      ),
    ).toBe(true);

    const fixmeDiff = [
      '--- a/e2e/generated/x.spec.ts',
      '+++ b/e2e/generated/x.spec.ts',
      '@@ -1,3 +1,3 @@',
      "-test('flaky', async ({ page }) => {",
      "+test.fixme('flaky', async ({ page }) => {",
    ].join('\n');
    const fixmeResult = filterHealPatch(fixmeDiff);
    expect(fixmeResult.allowed).toBe('');
    expect(fixmeResult.rejected.some((h) => h.reasons.some((r) => r.includes('fixme')))).toBe(true);
  });

  test('allows a pure waitFor / timeout change', () => {
    const diff = [
      '--- a/e2e/generated/x.spec.ts',
      '+++ b/e2e/generated/x.spec.ts',
      "@@ -5,3 +5,3 @@ test('spinner', async ({ page }) => {",
      "-  await page.waitForSelector('.spinner', { timeout: 5000 });",
      "+  await page.waitForSelector('.spinner', { timeout: 15000 });",
    ].join('\n');
    const result = filterHealPatch(diff);
    expect(result.allowed).toContain('timeout: 15000');
    expect(result.rejected).toHaveLength(0);
  });

  test('touchedStepRegions surfaces the step region of an allowed selector change', () => {
    const diff = [
      '--- a/e2e/generated/login.spec.ts',
      '+++ b/e2e/generated/login.spec.ts',
      "@@ -10,5 +10,5 @@ test('login', async ({ page }) => {",
      '   // @step jrn-login/s2 로그인 버튼 클릭',
      "-  await page.getByRole('button', { name: 'Sign in' }).click();",
      "+  await page.getByRole('button', { name: 'Log in' }).click();",
    ].join('\n');
    const result = filterHealPatch(diff);
    expect(result.touchedStepRegions).toContain('jrn-login/s2');
  });
});
