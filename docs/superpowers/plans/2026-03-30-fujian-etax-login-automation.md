# Fujian ETax Login Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone Stagehand script that opens the Fujian eTax portal, dismisses the notice popup, logs in with fixed credentials, and retries the image captcha up to three times with human-like pauses.

**Architecture:** Keep the browser workflow in a dedicated example script under `packages/core/examples/v3`, and isolate deterministic helper logic such as delay generation, captcha instruction text, and retry outcome calculation into a small helper module under `packages/core/lib/v3/examples`. Cover the deterministic helper behavior with a focused unit test.

**Tech Stack:** TypeScript, Stagehand V3, Playwright-compatible page APIs, Vitest

---

### Task 1: Add the failing helper test

**Files:**
- Create: `packages/core/tests/unit/fujian-etax-login.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("getCaptchaAttemptOutcome", () => {
  it("fails on the third visible captcha attempt", () => {
    expect(getCaptchaAttemptOutcome(true, 3)).toBe("failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/fujian-etax-login.test.ts --config ./vitest.src.config.ts`
Expected: FAIL because `../../lib/v3/examples/fujianEtaxLogin.js` does not exist yet.

### Task 2: Implement the helper module

**Files:**
- Create: `packages/core/lib/v3/examples/fujianEtaxLogin.ts`
- Modify: `packages/core/tests/unit/fujian-etax-login.test.ts`

- [ ] **Step 1: Write the minimal helper exports**

```ts
export function getRandomDelayMs(random = Math.random): number {
  return 1_000 + Math.floor(random() * 1_001);
}
```

- [ ] **Step 2: Add captcha retry outcome logic**

```ts
export function getCaptchaAttemptOutcome(
  captchaStillVisible: boolean,
  attempt: number,
  maxAttempts = 3,
): "solved" | "retry" | "failed" {
  if (!captchaStillVisible) return "solved";
  return attempt >= maxAttempts ? "failed" : "retry";
}
```

- [ ] **Step 3: Add the fixed captcha `act()` instruction string**

```ts
export function buildCaptchaActInstruction(): string {
  return "在当前验证码弹窗中，先阅读右上角小图里的文字顺序，再在下方大图中按相同顺序依次点击对应文字，完成后点击“确定”按钮。";
}
```

- [ ] **Step 4: Run the focused unit test**

Run: `pnpm exec vitest run tests/unit/fujian-etax-login.test.ts --config ./vitest.src.config.ts`
Expected: PASS

### Task 3: Add the standalone browser automation script

**Files:**
- Create: `packages/core/examples/v3/fujian_etax_login.ts`
- Modify: `packages/core/lib/v3/examples/fujianEtaxLogin.ts`

- [ ] **Step 1: Initialize Stagehand and navigation flow**

```ts
const stagehand = new Stagehand({
  env: "LOCAL",
  model: process.env.STAGEHAND_MODEL_NAME ?? "openai/gpt-4.1-mini",
  verbose: 2,
});
```

- [ ] **Step 2: Implement popup, login, and captcha helper functions**

```ts
await page.goto("https://etax.fujian.chinatax.gov.cn:8443/", {
  waitUntil: "load",
});
```

- [ ] **Step 3: Use `stagehand.act()` for the captcha retry loop**

```ts
await stagehand.act(buildCaptchaActInstruction(), {
  page,
  timeout: 45_000,
});
```

- [ ] **Step 4: Stop after success or after 3 failures**

Run: `pnpm --filter @browserbasehq/stagehand run example -- v3/fujian_etax_login`
Expected: Script opens the site and logs progress through popup, login, and captcha handling.

### Task 4: Verify the deliverable

**Files:**
- Modify: `packages/core/vitest.src.config.ts`

- [ ] **Step 1: Re-run the focused unit test**

Run: `pnpm exec vitest run tests/unit/fujian-etax-login.test.ts --config ./vitest.src.config.ts`
Expected: PASS

- [ ] **Step 2: Type-check the new files with the package compiler**

Run: `pnpm -w exec tsc -p packages/core/tsconfig.json --noEmit`
Expected: PASS
