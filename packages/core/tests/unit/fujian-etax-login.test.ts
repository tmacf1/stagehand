import { describe, expect, it } from "vitest";
import {
  buildCaptchaCoordinateExtractionPrompt,
  buildVisibleTextMatchExpression,
  getCaptchaAttemptOutcome,
  getRandomDelayMs,
  normalizeCaptchaPointsPayload,
  normalizeCaptchaResponseText,
  projectCaptchaPointToViewport,
} from "../../examples/fujian_etax_login.js";

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

describe("buildCaptchaCoordinateExtractionPrompt", () => {
  it("asks for a coordinate array using the top-left origin", () => {
    const prompt = buildCaptchaCoordinateExtractionPrompt();

    expect(prompt).toContain('"points"');
    expect(prompt).toContain("左上角为坐标原点 (0,0)");
    expect(prompt).toContain("1000x1000");
    expect(prompt).toContain("顶层只有 points 字段");
  });
});

describe("projectCaptchaPointToViewport", () => {
  it("maps captcha coordinates into the visible canvas bounds with a safe margin", () => {
    expect(
      projectCaptchaPointToViewport(
        { x: 0, y: 0 },
        { left: 100, top: 200, width: 300, height: 400 },
      ),
    ).toEqual({ x: 106, y: 206 });

    expect(
      projectCaptchaPointToViewport(
        { x: 1000, y: 1000 },
        { left: 100, top: 200, width: 300, height: 400 },
      ),
    ).toEqual({ x: 394, y: 594 });
  });
});

describe("normalizeCaptchaPointsPayload", () => {
  it("accepts tuple-style point arrays from the model", () => {
    expect(
      normalizeCaptchaPointsPayload([
        [286, 159],
        [518, 191],
      ]),
    ).toEqual([
      { x: 286, y: 159 },
      { x: 518, y: 191 },
    ]);
  });

  it("accepts coords wrapper objects from the model", () => {
    expect(
      normalizeCaptchaPointsPayload({
        coords: [
          [227, 584],
          [109, 178],
        ],
      }),
    ).toEqual([
      { x: 227, y: 584 },
      { x: 109, y: 178 },
    ]);
  });
});

describe("normalizeCaptchaResponseText", () => {
  it("converts tuple-style coordinate lists into JSON-compatible arrays", () => {
    expect(
      normalizeCaptchaResponseText("[(575, 637), (412, 637), (887, 450), (712, 637)]"),
    ).toBe("[[575, 637], [412, 637], [887, 450], [712, 637]]");
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
