import { describe, expect, it } from "vitest";
import {
  buildCaptchaAgentInstruction,
  buildCaptchaActInstruction,
  CAPTCHA_AGENT_EXCLUDED_TOOLS,
  buildVisibleTextMatchExpression,
  getCaptchaAttemptOutcome,
  getRandomDelayMs,
  isTextMatch,
} from "../../lib/v3/examples/fujianEtaxLogin.js";

describe("getRandomDelayMs", () => {
  it("returns the lower bound when random is 0", () => {
    expect(getRandomDelayMs(() => 0)).toBe(1_000);
  });

  it("returns the upper bound when random approaches 1", () => {
    expect(getRandomDelayMs(() => 0.999999)).toBe(2_000);
  });
});

describe("getCaptchaAttemptOutcome", () => {
  it("marks the captcha as solved when the dialog disappears", () => {
    expect(getCaptchaAttemptOutcome(false, 1)).toBe("solved");
  });

  it("retries while the captcha is still visible before the last attempt", () => {
    expect(getCaptchaAttemptOutcome(true, 1)).toBe("retry");
    expect(getCaptchaAttemptOutcome(true, 2)).toBe("retry");
  });

  it("fails on the third visible captcha attempt", () => {
    expect(getCaptchaAttemptOutcome(true, 3)).toBe("failed");
  });
});

describe("buildCaptchaActInstruction", () => {
  it("mentions the expected click-order behavior and confirmation button", () => {
    const instruction = buildCaptchaActInstruction();

    expect(instruction).toContain("右上角小图");
    expect(instruction).toContain("下方大图");
    expect(instruction).toContain("确定");
  });
});

describe("buildCaptchaAgentInstruction", () => {
  it("requires matching the click count to the small-image character count", () => {
    const instruction = buildCaptchaAgentInstruction();

    expect(instruction).toContain("先数清楚");
    expect(instruction).toContain("点击次数必须和小图中的字数完全一致");
    expect(instruction).toContain("坐标数组");
    expect(instruction).toContain("1000x1000");
    expect(instruction).toContain("不要补额外坐标");
    expect(instruction).toContain("随机等待 1 到 2 秒");
    expect(instruction).toContain("绝对不要点击验证码弹窗外部");
    expect(instruction).toContain("只有在完成全部汉字点击后");
    expect(instruction).toContain("确定");
  });
});

describe("CAPTCHA_AGENT_EXCLUDED_TOOLS", () => {
  it("removes navigation and unrelated hybrid tools", () => {
    expect(CAPTCHA_AGENT_EXCLUDED_TOOLS).toContain("goto");
    expect(CAPTCHA_AGENT_EXCLUDED_TOOLS).toContain("navback");
    expect(CAPTCHA_AGENT_EXCLUDED_TOOLS).toContain("search");
    expect(CAPTCHA_AGENT_EXCLUDED_TOOLS).toContain("fillFormVision");
    expect(CAPTCHA_AGENT_EXCLUDED_TOOLS).toContain("act");
  });
});

describe("isTextMatch", () => {
  it("matches the same text after trimming whitespace", () => {
    expect(isTextMatch("  我知道了  ", "我知道了")).toBe(true);
  });

  it("matches text split by line breaks", () => {
    expect(isTextMatch("我\n知道了", "我知道了")).toBe(true);
  });

  it("rejects different text", () => {
    expect(isTextMatch("登录", "我知道了")).toBe(false);
  });
});

describe("buildVisibleTextMatchExpression", () => {
  it("embeds the target texts into the page expression", () => {
    const expression = buildVisibleTextMatchExpression(["我知道了", "确定"]);

    expect(expression).toContain("我知道了");
    expect(expression).toContain("确定");
    expect(expression).toContain("getComputedStyle");
  });
});
