import fs from "node:fs";
import path from "node:path";
import { Stagehand } from "../lib/v3/index.js";
import { z } from "zod";
import { AISdkClient } from "../lib/v3/llm/aisdk.js";
import { getAISDKLanguageModel, LLMProvider } from "../lib/v3/llm/LLMProvider.js";
import type { LLMClient } from "../lib/v3/llm/LLMClient.js";
import type { AnyPage } from "../lib/v3/types/public/page.js";
import type { Frame } from "../lib/v3/understudy/frame.js";

export const FUJIAN_ETAX_URL = "https://etax.fujian.chinatax.gov.cn:8443/";
export const CAPTCHA_MAX_ATTEMPTS = 3;
export const DEFAULT_DELAY_MIN_MS = 1_000;
export const DEFAULT_DELAY_MAX_MS = 2_000;

export type CaptchaAttemptOutcome = "solved" | "retry" | "failed";
type BodyTextEvaluator = {
  evaluate: <T>(pageFunctionOrExpression: string | (() => T)) => Promise<T>;
};
type CaptchaFrame = Frame & BodyTextEvaluator & { frameId: string };

export type VisibleTextMatch = {
  tag: string;
  text: string;
  className: string;
  id: string;
  role: string;
};

export type CaptchaPoint = {
  x: number;
  y: number;
};

export type CaptchaViewportRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const taxpayerId =
  process.env.FUJIAN_ETAX_TAXPAYER_ID ?? "21233423";
const username =
  process.env.FUJIAN_ETAX_USERNAME ?? "34213";
const password =
  process.env.FUJIAN_ETAX_PASSWORD ?? "23421";
const interactionModel =
  process.env.STAGEHAND_MODEL_NAME ??
  process.env.STAGEHAND_MODEL ??
  "openai/gpt-4.1-mini";
const captchaModel =
  process.env.STAGEHAND_MODEL_NAME ??
  process.env.STAGEHAND_MODEL ??
  "openai/gpt-4.1-mini";
const stagehandModelConfig =
  interactionModel.startsWith("newapi/")
    ? {
        modelName: interactionModel,
        apiKey: process.env.NEWAPI_API_KEY,
        baseURL: process.env.NEWAPI_BASE_URL,
      }
    : interactionModel;
const autoClose =
  process.env.FUJIAN_ETAX_AUTO_CLOSE === "1" ||
  process.env.FUJIAN_ETAX_AUTO_CLOSE === "true";
const logFilePath =
  process.env.FUJIAN_ETAX_LOG_FILE ??
  path.resolve(process.cwd(), "..", "..", ".runtime", "test.log");
const captchaPointsSchema = z.object({
  points: z
    .array(
      z.object({
        x: z.number().min(0).max(1000),
        y: z.number().min(0).max(1000),
      }),
    )
    .min(1)
    .max(6),
});

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function getRandomDelayMs(
  random: () => number = Math.random,
  minMs = DEFAULT_DELAY_MIN_MS,
  maxMs = DEFAULT_DELAY_MAX_MS,
): number {
  if (maxMs < minMs) {
    throw new Error("maxMs must be greater than or equal to minMs");
  }

  const span = maxMs - minMs + 1;
  return minMs + Math.floor(random() * span);
}

export async function humanPause(
  _page: AnyPage,
  label: string,
  random: () => number = Math.random,
): Promise<void> {
  const delayMs = getRandomDelayMs(random);
  console.log(`[pause] ${label}: waiting ${delayMs}ms`);
  await sleep(delayMs);
}

export function getCaptchaAttemptOutcome(
  captchaStillVisible: boolean,
  attempt: number,
  maxAttempts = CAPTCHA_MAX_ATTEMPTS,
): CaptchaAttemptOutcome {
  if (!captchaStillVisible) {
    return "solved";
  }

  return attempt >= maxAttempts ? "failed" : "retry";
}

export function buildCaptchaCoordinateExtractionPrompt(): string {
  return [
    "小图是验证码文字顺序提示图，大图是需要点击的目标图。",
    "请根据小图的汉字顺序，帮我在大图中依次找出小图中汉字的位置。",
    "请明确按照以下规则理解坐标：左上角为坐标原点 (0,0)，x 轴从左向右增大，y 轴从上向下增大。",
    "请把大图统一映射到 1000x1000 的坐标系后再给出坐标。",
    "如果小图里有4个字，就只返回4个坐标；如果有5个字，就只返回5个坐标。",
    '你必须只返回这一种 JSON 格式：{"points":[{"x":123,"y":456},{"x":234,"y":567}]}。',
    "不要返回 coords、coord、data、result 等其他字段名。",
    "不要返回 [[x,y]]，不要返回 (x,y)，不要返回 markdown 代码块，不要返回解释文字。",
    "最终输出必须是可直接 JSON.parse 的单个 JSON 对象，且顶层只有 points 字段。",
  ].join("");
}

export function projectCaptchaPointToViewport(
  point: CaptchaPoint,
  rect: CaptchaViewportRect,
  safeMarginPx = 6,
): CaptchaPoint {
  const clamp = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, value));
  const normalizedX = clamp(point.x, 0, 1000) / 1000;
  const normalizedY = clamp(point.y, 0, 1000) / 1000;
  const minX = rect.left + safeMarginPx;
  const maxX = rect.left + rect.width - safeMarginPx;
  const minY = rect.top + safeMarginPx;
  const maxY = rect.top + rect.height - safeMarginPx;

  return {
    x: Math.round(clamp(rect.left + rect.width * normalizedX, minX, maxX)),
    y: Math.round(clamp(rect.top + rect.height * normalizedY, minY, maxY)),
  };
}

export function normalizeCaptchaPointsPayload(
  parsed: unknown,
): Array<{ x: unknown; y: unknown }> | unknown {
  if (
    parsed &&
    typeof parsed === "object" &&
    "coords" in parsed &&
    Array.isArray((parsed as { coords?: unknown }).coords)
  ) {
    return normalizeCaptchaPointsPayload(
      (parsed as { coords: unknown[] }).coords,
    );
  }

  if (!Array.isArray(parsed)) {
    return parsed;
  }

  return parsed.map((item) => {
    if (Array.isArray(item) && item.length >= 2) {
      return {
        x: item[0],
        y: item[1],
      };
    }
    return item;
  });
}

export function normalizeCaptchaResponseText(rawContent: string): string {
  const stripped = String(rawContent)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  if (/^\[\s*\(/.test(stripped)) {
    return stripped.replace(/\(/g, "[").replace(/\)/g, "]");
  }

  return stripped;
}

export function buildVisibleTextMatchExpression(targets: string[]): string {
  const candidateTexts = JSON.stringify(targets);

  return `
    (() => {
      try {
        const targets = ${candidateTexts};
        const normalize = (value) => String(value ?? "").replace(/\\s+/g, "");
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };

        const selectors = [
          "button",
          "[role='button']",
          ".t-button",
          ".el-button",
          ".ant-btn",
          "a",
          "span",
          "div"
        ];

        const elements = Array.from(document.querySelectorAll(selectors.join(",")));

        return targets.some((target) =>
          elements.some((element) => {
            const text = normalize(element.textContent);
            return text === normalize(target) && isVisible(element);
          }),
        );
      } catch (error) {
        return false;
      }
    })()
  `;
}

export function buildVisibleTextMatchesDebugExpression(targets: string[]): string {
  const candidateTexts = JSON.stringify(targets);

  return `
    (() => {
      try {
        const targets = ${candidateTexts};
        const normalize = (value) => String(value ?? "").replace(/\\s+/g, "");
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };

        const selectors = [
          "button",
          "[role='button']",
          ".t-button",
          ".el-button",
          ".ant-btn",
          "a",
          "span",
          "div"
        ];

        return Array.from(document.querySelectorAll(selectors.join(",")))
          .filter((element) => isVisible(element))
          .map((element) => ({
            tag: element.tagName,
            text: String(element.textContent ?? "").trim(),
            className: typeof element.className === "string" ? element.className : "",
            id: element.id ?? "",
            role: element.getAttribute("role") ?? "",
          }))
          .filter((element) =>
            targets.some((target) => normalize(element.text) === normalize(target)),
          )
          .slice(0, 20);
      } catch (error) {
        return [];
      }
    })()
  `;
}

async function bodyText(page: AnyPage): Promise<string> {
  const evaluator = page as BodyTextEvaluator;
  return (
    (await evaluator
      .evaluate(() => document.body?.innerText ?? "")
      .catch(() => "")) ?? ""
  ).replace(/\s+/g, " ");
}

export async function pageHasVisibleText(
  page: AnyPage,
  targets: string[],
): Promise<boolean> {
  const evaluator = page as BodyTextEvaluator;
  return await evaluator.evaluate<boolean>(
    buildVisibleTextMatchExpression(targets),
  );
}

export async function getVisibleTextMatches(
  page: AnyPage,
  targets: string[],
): Promise<VisibleTextMatch[]> {
  const evaluator = page as BodyTextEvaluator;
  return await evaluator.evaluate<VisibleTextMatch[]>(
    buildVisibleTextMatchesDebugExpression(targets),
  );
}

export async function clickFirstVisibleSelector(
  page: AnyPage,
  selectors: string[],
): Promise<string | null> {
  const pageWithLocator = page as AnyPage & {
    locator: (selector: string) => {
      count: () => Promise<number>;
      click: () => Promise<void>;
    };
  };

  for (const selector of selectors) {
    try {
      const locator = pageWithLocator.locator(selector);
      const count = await locator.count();
      if (count === 0) {
        continue;
      }

      await locator.click();
      return selector;
    } catch {
      continue;
    }
  }

  return null;
}

export async function fillFirstMatchingSelector(
  page: AnyPage,
  selectors: string[],
  value: string,
): Promise<string | null> {
  const pageWithLocator = page as AnyPage & {
    locator: (selector: string) => {
      count: () => Promise<number>;
      fill: (value: string) => Promise<void>;
      inputValue: () => Promise<string>;
    };
  };

  for (const selector of selectors) {
    try {
      const locator = pageWithLocator.locator(selector);
      const count = await locator.count();
      if (count === 0) {
        continue;
      }

      await locator.fill(value);
      const currentValue = await locator.inputValue();
      if (currentValue === value) {
        return selector;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export async function clickVisibleTextButton(
  page: BodyTextEvaluator,
  targets: string[],
): Promise<boolean> {
  const evaluator = page as BodyTextEvaluator;

  return await evaluator.evaluate(`
    (() => {
      try {
        const targets = ${JSON.stringify(targets)};
        const normalize = (value) => String(value ?? "").replace(/\\s+/g, "");
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };

        const selectors = [
          "button",
          "[role='button']",
          ".t-button",
          ".el-button",
          ".ant-btn",
          "a",
          "span",
          "div"
        ];

        const elements = Array.from(document.querySelectorAll(selectors.join(",")));
        const clickTarget = (element) => {
          const clickable = element.closest(
            "button, [role='button'], a, .t-button, .el-button, .ant-btn",
          ) || element;
          clickable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          clickable.click();
        };

        for (const target of targets) {
          const match = elements.find((element) => {
            const text = normalize(element.textContent);
            return text === normalize(target) && isVisible(element);
          });

          if (match) {
            clickTarget(match);
            return true;
          }
        }

        return false;
      } catch (error) {
        return false;
      }
    })()
  `);
}

export async function waitForCondition(
  page: AnyPage,
  timeoutMs: number,
  pollMs: number,
  predicate: () => Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await sleep(pollMs);
  }

  return await predicate();
}

export async function isLoginPageVisible(page: AnyPage): Promise<boolean> {
  const text = await bodyText(page);
  const url = await (page as AnyPage & { url: () => string }).url();
  const textSignals =
    (
      text.includes("统一社会信用代码/纳税人识别号") &&
      text.includes("居民身份证号码/手机号码/用户名")
    ) ||
    text.includes("个人用户密码");

  const urlSignals =
    url.includes("login") ||
    url.includes("dl") ||
    url.includes("signin");

  const passwordFieldVisible = await pageHasVisibleText(page, ["个人用户密码"]);

  return (
    urlSignals ||
    passwordFieldVisible ||
    text.includes("统一社会信用代码/纳税人识别号") &&
      text.includes("居民身份证号码/手机号码/用户名") &&
      text.includes("个人用户密码") ||
    textSignals
  );
}

export async function isCaptchaDialogVisible(page: AnyPage): Promise<boolean> {
  const text = await bodyText(page);
  const hasCaptchaText =
    text.includes("请依次点击") ||
    text.includes("验证码") ||
    text.includes("验证");

  if (!hasCaptchaText) {
    return false;
  }

  return text.includes("确定");
}

export async function waitForCaptchaDialog(page: AnyPage): Promise<boolean> {
  return await waitForCondition(page, 15_000, 500, async () =>
    isCaptchaDialogVisible(page),
  );
}

export async function waitForCaptchaToResolve(page: AnyPage): Promise<boolean> {
  return await waitForCondition(page, 8_000, 500, async () => {
    const stillVisible = await isCaptchaDialogVisible(page);
    return !stillVisible;
  });
}

async function findAction(
  stagehand: Stagehand,
  instructions: string[],
  page?: AnyPage,
) {
  for (const instruction of instructions) {
    const actions = await stagehand.observe(instruction, page ? { page } : {});
    if (actions[0]) {
      return actions[0];
    }
  }

  return null;
}

export async function observeAndActAny(
  stagehand: Stagehand,
  instructions: string[],
  page?: AnyPage,
): Promise<void> {
  const action = await findAction(stagehand, instructions, page);
  if (!action) {
    throw new Error(
      `No action found for instructions: ${instructions.join(" | ")}`,
    );
  }

  await stagehand.act(action, page ? { page, timeout: 30_000 } : { timeout: 30_000 });
}

export async function waitForLoginPage(page: AnyPage): Promise<void> {
  const found = await waitForCondition(page, 15_000, 500, async () => {
    return await isLoginPageVisible(page);
  });

  if (!found) {
    throw new Error("Timed out waiting for the Fujian eTax login page.");
  }
}

function mirrorProcessOutputToLogFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stream = fs.createWriteStream(filePath, { flags: "a" });
  const header = `\n===== Fujian eTax run ${new Date().toISOString()} =====\n`;
  stream.write(header);

  const originalStdoutWrite = process.stdout.write.bind(process.stdout) as (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    cb?: (error?: Error | null) => void,
  ) => boolean;
  const originalStderrWrite = process.stderr.write.bind(process.stderr) as (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    cb?: (error?: Error | null) => void,
  ) => boolean;

  const createPatchedWrite =
    (
      originalWrite: typeof originalStdoutWrite,
    ): typeof originalStdoutWrite =>
    (chunk, encodingOrCallback, callback) => {
      const callbackFn =
        typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      const encoding =
        typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;

      stream.write(chunk, () => {});
      return originalWrite(chunk, encoding, callbackFn);
    };

  process.stdout.write = createPatchedWrite(originalStdoutWrite);
  process.stderr.write = createPatchedWrite(originalStderrWrite);
  originalStdoutWrite(`Writing run logs to ${filePath}\n`);
}

function installTimestampedConsole(): void {
  const methods = ["log", "warn", "error", "info"] as const;

  for (const method of methods) {
    const original = console[method].bind(console) as (...args: unknown[]) => void;
    console[method] = ((...args: unknown[]) => {
      const timestamp = `[${new Date().toISOString()}]`;
      original(timestamp, ...args);
    }) as typeof console[typeof method];
  }
}

function getClientOptionsForModel(modelName: string) {
  if (modelName.startsWith("newapi/")) {
    return {
      apiKey: process.env.NEWAPI_API_KEY,
      baseURL: process.env.NEWAPI_BASE_URL,
    };
  }

  return undefined;
}

function createLlmClientForModel(modelName: string): LLMClient {
  const provider = new LLMProvider(() => {});
  return provider.getClient(
    modelName,
    getClientOptionsForModel(modelName),
    { experimental: true },
  );
}

async function getFrameViewportOffset(
  page: AnyPage,
  frameId: string,
): Promise<{ x: number; y: number }> {
  const pageWithInternals = page as AnyPage & {
    registry?: {
      getOwnerBackendNodeId?: (id: string) => number | undefined;
    };
    mainSession?: {
      send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
    };
  };

  const backendNodeId = pageWithInternals.registry?.getOwnerBackendNodeId?.(frameId);
  const mainSession = pageWithInternals.mainSession;

  if (!backendNodeId || !mainSession) {
    return { x: 0, y: 0 };
  }

  try {
    await mainSession.send("DOM.enable");
    const { model } = await mainSession.send<{
      model: { content: number[] };
    }>("DOM.getBoxModel", {
      backendNodeId,
    });

    return {
      x: model.content[0] ?? 0,
      y: model.content[1] ?? 0,
    };
  } catch {
    return { x: 0, y: 0 };
  }
}

type CaptchaDomAssets = {
  smallDataUrl: string;
  largeDataUrl: string;
  maskRect: { left: number; top: number; width: number; height: number };
};

async function extractCaptchaDomAssets(
  page: BodyTextEvaluator,
): Promise<CaptchaDomAssets | null> {
  const evaluator = page as BodyTextEvaluator;

  return await evaluator.evaluate<CaptchaDomAssets | null>(() => {
    const small = document.querySelector<HTMLImageElement>("#tpass-captcha-tip-img");
    const large = document.querySelector<HTMLImageElement>("#tpass-captcha-slider-bg-img");
    const mask = document.querySelector<HTMLElement>("#bg-img-click-mask");
    const captcha = document.querySelector<HTMLElement>("#tpass-captcha");

    if (!small || !large || !mask || !captcha) {
      return null;
    }

    const style = window.getComputedStyle(captcha);
    const captchaRect = captcha.getBoundingClientRect();
    const maskRect = mask.getBoundingClientRect();
    const visible =
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || "1") > 0 &&
      captchaRect.width > 0 &&
      captchaRect.height > 0 &&
      maskRect.width > 0 &&
      maskRect.height > 0;

    if (!visible || !small.src || !large.src) {
      return null;
    }

    return {
      smallDataUrl: small.src,
      largeDataUrl: large.src,
      maskRect: {
        left: maskRect.left,
        top: maskRect.top,
        width: maskRect.width,
        height: maskRect.height,
      },
    };
  });
}

async function findCaptchaCaptureContext(page: AnyPage) {
  const pageWithFrames = page as AnyPage & {
    frames?: () => Frame[];
  };
  const mainAssets = await extractCaptchaDomAssets(page);
  if (mainAssets) {
    return {
      captureTarget: page,
      clickOffset: { x: 0, y: 0 },
      assets: mainAssets,
      label: "main-page",
    };
  }

  const frames = (pageWithFrames.frames?.() ?? []) as CaptchaFrame[];
  for (const frame of frames) {
    try {
      const text = await frame.evaluate(() => document.body?.innerText ?? "");

      if (
        !text.includes("验证码") &&
        !text.includes("请依次点击") &&
        !text.includes("确定")
      ) {
        continue;
      }

      const frameAssets = await extractCaptchaDomAssets(frame);
      if (!frameAssets) {
        continue;
      }

      const clickOffset = frame.frameId
        ? await getFrameViewportOffset(page, frame.frameId)
        : { x: 0, y: 0 };

      return {
        captureTarget: frame,
        clickOffset,
        assets: frameAssets,
        label: `frame:${frame.frameId ?? "unknown"}`,
      };
    } catch {
      continue;
    }
  }

  return null;
}

async function captureCaptchaImageDataUrls(
  page: AnyPage,
) {
  const context = await findCaptchaCaptureContext(page);
  if (!context) {
    throw new Error("Unable to locate the captcha small image and large canvas.");
  }

  console.log(
    "Captcha image targets:",
    JSON.stringify(
      {
        source: context.label,
        clickOffset: context.clickOffset,
        maskRect: context.assets.maskRect,
        smallPrefix: context.assets.smallDataUrl.slice(0, 32),
        largePrefix: context.assets.largeDataUrl.slice(0, 32),
      },
      null,
      2,
    ),
  );

  return {
    confirmTarget: context.captureTarget,
    targets: {
      small: {
        left: context.assets.maskRect.left + context.clickOffset.x,
        top: context.assets.maskRect.top + context.clickOffset.y,
        width: context.assets.maskRect.width,
        height: context.assets.maskRect.height,
      },
      large: {
        left: context.assets.maskRect.left + context.clickOffset.x,
        top: context.assets.maskRect.top + context.clickOffset.y,
        width: context.assets.maskRect.width,
        height: context.assets.maskRect.height,
      },
    },
    smallDataUrl: context.assets.smallDataUrl,
    largeDataUrl: context.assets.largeDataUrl,
  };
}

async function requestCaptchaPoints(
  llmClient: LLMClient,
  smallDataUrl: string,
  largeDataUrl: string,
) {
  const response = await llmClient.createChatCompletion({
    logger: () => {},
    options: {
      temperature: 0,
      maxOutputTokens: 500,
      messages: [
        {
          role: "system",
          content:
            "你是验证码坐标识别助手。你只能返回 JSON，不要输出解释、不要输出 markdown 代码块。",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "第一张图片是小图。" },
            { type: "image_url", image_url: { url: smallDataUrl } },
            { type: "text", text: "第二张图片是大图。" },
            { type: "image_url", image_url: { url: largeDataUrl } },
            { type: "text", text: buildCaptchaCoordinateExtractionPrompt() },
          ],
        },
      ],
    },
  });

  const rawContent = response.choices?.[0]?.message?.content ?? "";
  console.log("Captcha model raw response:", rawContent);
  const normalized = normalizeCaptchaResponseText(rawContent);
  console.log("Captcha model normalized response:", normalized);

  const parsed = JSON.parse(normalized);
  const normalizedPoints = normalizeCaptchaPointsPayload(parsed);
  const candidate =
    Array.isArray(normalizedPoints)
      ? { points: normalizedPoints }
      : normalizedPoints;
  const validated = captchaPointsSchema.parse(candidate);
  console.log(
    "Captcha model parsed points:",
    JSON.stringify(validated.points, null, 2),
  );
  return validated.points;
}

async function clickCaptchaPoints(
  page: AnyPage,
  points: Array<{ x: number; y: number }>,
  canvasRect: { left: number; top: number; width: number; height: number },
): Promise<void> {
  const clickablePage = page as AnyPage & {
    click: (x: number, y: number) => Promise<unknown>;
  };

  for (const [index, point] of points.entries()) {
    await humanPause(page, `clicking captcha point ${index + 1}`);
    const projectedPoint = projectCaptchaPointToViewport(point, canvasRect);
    console.log(
      "Captcha click projection:",
      JSON.stringify(
        {
          index: index + 1,
          captchaPoint: point,
          viewportPoint: projectedPoint,
        },
        null,
        2,
      ),
    );
    await clickablePage.click(projectedPoint.x, projectedPoint.y);
  }
}

async function dismissNoticePopupIfNeeded(stagehand: Stagehand): Promise<void> {
  const page = stagehand.context.pages()[0];
  const dismissTexts = ["我知道了", "知道了", "确定", "关闭"];
  const popupVisible = await pageHasVisibleText(page, dismissTexts);

  if (!popupVisible) {
    console.log("No notice popup detected.");
    return;
  }

  console.log("Notice popup detected. Clicking 我知道了.");
  await humanPause(page, "dismissing notice popup");

  const visibleMatchesBefore = await getVisibleTextMatches(page, dismissTexts);
  console.log(
    "Visible popup dismiss candidates before click:",
    JSON.stringify(visibleMatchesBefore, null, 2),
  );

  const selectorClicked = await clickFirstVisibleSelector(page, [
    "button.main_footer_btn",
    ".main_footer_btn",
    ".main_footer button",
    "[class*='main_footer'] button",
  ]);
  console.log(`Selector popup click result: ${selectorClicked ?? "none"}`);

  const clickedDirectly =
    selectorClicked !== null
      ? true
      : await clickVisibleTextButton(page, dismissTexts);
  console.log(`Direct popup click result: ${clickedDirectly}`);

  if (!clickedDirectly) {
    console.log("Direct DOM click did not find a match. Falling back to Stagehand observe/act.");
    await observeAndActAny(stagehand, [
      "click the 我知道了 button in the visible popup dialog",
      "click the button labeled 我知道了 in the modal",
      "click the confirmation button in the visible notice popup",
    ], page);
  }

  const popupDismissed = await waitForCondition(page, 5_000, 400, async () => {
    const stillVisible = await pageHasVisibleText(page, dismissTexts);
    return !stillVisible;
  });

  if (!popupDismissed) {
    const visibleMatchesAfter = await getVisibleTextMatches(page, dismissTexts);
    console.log(
      "Visible popup dismiss candidates after click:",
      JSON.stringify(visibleMatchesAfter, null, 2),
    );
    throw new Error("The home-page notice popup is still visible after clicking the dismiss button.");
  }
}

async function openLoginPage(stagehand: Stagehand): Promise<void> {
  const page = stagehand.context.pages()[0];
  await humanPause(page, "opening the login entry");

  const loginTexts = ["登录"];
  const visibleMatchesBefore = await getVisibleTextMatches(page, loginTexts);
  console.log(
    "Visible login candidates before click:",
    JSON.stringify(visibleMatchesBefore, null, 2),
  );

  const loginPageVisibleSoon = async () =>
    await waitForCondition(page, 10_000, 400, async () => {
      return await isLoginPageVisible(page);
    });

  const clickedByText = await clickVisibleTextButton(page, loginTexts);
  console.log(`Direct login click result: ${clickedByText}`);
  if (clickedByText && (await loginPageVisibleSoon())) {
    console.log("Login page detected after direct text click.");
    return;
  }

  const selectorClicked = await clickFirstVisibleSelector(page, [
    "button.login_btn",
    ".login_btn",
    "header .login_btn",
    ".header .login_btn",
    ".top .login_btn",
    ".nav .login_btn",
  ]);
  console.log(`Selector login click result: ${selectorClicked ?? "none"}`);
  if (selectorClicked && (await loginPageVisibleSoon())) {
    console.log("Login page detected after selector click.");
    return;
  }

  console.log("Falling back to Stagehand observe/act for top login button.");
  await observeAndActAny(stagehand, [
    "click the 登录 button in the top navigation bar",
    "click the top menu 登录 button",
    "click the 登录 button in the header",
  ], page);

  await waitForLoginPage(page);
}

async function fillCredentialsAndSubmit(stagehand: Stagehand): Promise<void> {
  const page = stagehand.context.pages()[0];

  await humanPause(page, "typing the taxpayer identifier");
  const taxpayerSelector = await fillFirstMatchingSelector(
    page,
    [
      'input[placeholder="统一社会信用代码/纳税人识别号"]',
      'input[aria-label="统一社会信用代码/纳税人识别号"]',
      'input[name*="credit"]',
      'input[name*="tax"]',
    ],
    taxpayerId,
  );
  console.log(`Taxpayer field fill result: ${taxpayerSelector ?? "fallback-act"}`);
  if (!taxpayerSelector) {
    await stagehand.act(
      `type '${taxpayerId}' into the input labeled '统一社会信用代码/纳税人识别号'`,
      { page, timeout: 30_000 },
    );
  }

  await humanPause(page, "typing the username");
  const usernameSelector = await fillFirstMatchingSelector(
    page,
    [
      'input[placeholder="居民身份证号码/手机号码/用户名"]',
      'input[aria-label="居民身份证号码/手机号码/用户名"]',
      'input[name*="user"]',
      'input[name*="mobile"]',
      'input[name*="phone"]',
    ],
    username,
  );
  console.log(`Username field fill result: ${usernameSelector ?? "fallback-act"}`);
  if (!usernameSelector) {
    await stagehand.act(
      `type '${username}' into the input labeled '居民身份证号码/手机号码/用户名'`,
      { page, timeout: 30_000 },
    );
  }

  await humanPause(page, "typing the password");
  const passwordSelector = await fillFirstMatchingSelector(
    page,
    [
      'input[placeholder="个人用户密码"]',
      'input[aria-label="个人用户密码"]',
      'input[type="password"]',
      'input[name*="password"]',
      'input[name*="pwd"]',
    ],
    password,
  );
  console.log(`Password field fill result: ${passwordSelector ?? "fallback-act"}`);
  if (!passwordSelector) {
    await stagehand.act(`type '${password}' into the input labeled '个人用户密码'`, {
      page,
      timeout: 30_000,
    });
  }

  await humanPause(page, "submitting the login form");
  const loginTexts = ["登录"];
  const visibleMatchesBefore = await getVisibleTextMatches(page, loginTexts);
  console.log(
    "Visible form login candidates before click:",
    JSON.stringify(visibleMatchesBefore, null, 2),
  );

  const captchaVisibleSoon = async () =>
    await waitForCondition(page, 4_000, 400, async () =>
      isCaptchaDialogVisible(page),
    );

  const clickedByText = await clickVisibleTextButton(page, loginTexts);
  console.log(`Direct form login click result: ${clickedByText}`);
  if (clickedByText && (await captchaVisibleSoon())) {
    console.log("Captcha dialog detected after direct form login click.");
    return;
  }

  const selectorClicked = await clickFirstVisibleSelector(page, [
    "button[type='submit']",
    ".login_btn",
    "button.login_btn",
    "button[class*='submit']",
    "button[class*='login']",
  ]);
  console.log(`Selector form login click result: ${selectorClicked ?? "none"}`);
  if (selectorClicked && (await captchaVisibleSoon())) {
    console.log("Captcha dialog detected after selector form login click.");
    return;
  }

  console.log("Falling back to Stagehand observe/act for form login button.");
  await observeAndActAny(stagehand, [
    "click the 登录 button on the login form",
    "click the primary 登录 button in the form",
  ], page);
}

async function solveCaptcha(
  stagehand: Stagehand,
  captchaLlmClient: LLMClient,
): Promise<boolean> {
  const page = stagehand.context.pages()[0];
  const captchaShown = await waitForCaptchaDialog(page);

  if (!captchaShown) {
    console.log("No captcha dialog detected. Waiting for a future captcha trigger.");
    return true;
  }

  console.log(
    "Captcha model config:",
    JSON.stringify(
      {
        model: captchaModel,
        apiKeyPresent: Boolean(getClientOptionsForModel(captchaModel)?.apiKey),
        baseURLPresent: Boolean(getClientOptionsForModel(captchaModel)?.baseURL),
      },
      null,
      2,
    ),
  );

  for (let attempt = 1; attempt <= CAPTCHA_MAX_ATTEMPTS; attempt += 1) {
    await humanPause(page, `starting captcha attempt ${attempt}`);
    console.log(`Captcha attempt ${attempt}/${CAPTCHA_MAX_ATTEMPTS}`);

    try {
      const { confirmTarget, targets, smallDataUrl, largeDataUrl } =
        await captureCaptchaImageDataUrls(page);
      const points = await requestCaptchaPoints(
        captchaLlmClient,
        smallDataUrl,
        largeDataUrl,
      );

      console.log(
        "Captcha coordinate result:",
        JSON.stringify(
          {
            count: points.length,
            points,
          },
          null,
          2,
        ),
      );

      await clickCaptchaPoints(page, points, targets.large);
      await humanPause(page, "confirming the captcha");

      const clickedByText = await clickVisibleTextButton(confirmTarget, ["确定"]);
      if (!clickedByText) {
        throw new Error("Unable to click the captcha confirm button.");
      }
      console.log("Captcha confirm click result: text-match");
    } catch (error) {
      console.warn(`Captcha coordinate flow failed on attempt ${attempt}:`, error);
    }

    const solved = await waitForCaptchaToResolve(page);
    const outcome = getCaptchaAttemptOutcome(!solved, attempt);

    if (outcome === "solved") {
      console.log("Captcha dialog disappeared. Current verification round completed.");
      return true;
    }

    if (outcome === "retry") {
      console.log("Captcha still visible. Waiting for the next image and retrying.");
      continue;
    }

    throw new Error("Captcha failed three times. Stopping the automation.");
  }

  return false;
}

async function monitorCaptchaDialogs(
  stagehand: Stagehand,
  captchaLlmClient: LLMClient,
): Promise<void> {
  const page = stagehand.context.pages()[0];
  let lastVisible = false;

  console.log(
    "Entering persistent captcha monitor mode. If a captcha dialog appears again after manual actions, it will be processed automatically.",
  );

  while (true) {
    const captchaVisible = await isCaptchaDialogVisible(page).catch(() => false);

    if (captchaVisible && !lastVisible) {
      console.log("Captcha dialog detected by monitor. Starting a verification round.");
      const solved = await solveCaptcha(stagehand, captchaLlmClient);
      if (!solved) {
        throw new Error("Captcha monitoring stopped because the verification round did not complete.");
      }
      console.log(
        "Captcha monitor is idle again and will continue waiting for the next captcha dialog.",
      );
    }

    lastVisible = captchaVisible;
    await sleep(500);
  }
}

async function run(): Promise<void> {
  mirrorProcessOutputToLogFile(logFilePath);
  installTimestampedConsole();

  const sharedLlmClient =
    interactionModel.startsWith("newapi/")
      ? new AISdkClient({
          model: getAISDKLanguageModel(
            "newapi",
            interactionModel.replace(/^newapi\//, ""),
            {
              apiKey: process.env.NEWAPI_API_KEY,
              baseURL: process.env.NEWAPI_BASE_URL,
            },
          ),
        })
      : undefined;

  const stagehand = new Stagehand({
    env: "LOCAL",
    experimental: true,
    model: stagehandModelConfig,
    llmClient: sharedLlmClient,
    localBrowserLaunchOptions: {
      headless: false,
    },
    verbose: 2,
  });
  const captchaLlmClient = createLlmClientForModel(captchaModel);

  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0];

    console.log(`Navigating to ${FUJIAN_ETAX_URL}`);
    await page.goto(FUJIAN_ETAX_URL, { waitUntil: "load" });

    await humanPause(page, "waiting after initial page load");
    await dismissNoticePopupIfNeeded(stagehand);
    await openLoginPage(stagehand);
    await fillCredentialsAndSubmit(stagehand);
    const solved = await solveCaptcha(stagehand, captchaLlmClient);
    if (!solved) {
      throw new Error("Captcha dialog is still visible after the allowed retries.");
    }

    if (autoClose) {
      return;
    }

    await monitorCaptchaDialogs(stagehand, captchaLlmClient);
  } finally {
    if (autoClose) {
      await stagehand.close();
    } else {
      console.log(
        "Automation finished. Browser left open for inspection. Set FUJIAN_ETAX_AUTO_CLOSE=1 to close it automatically.",
      );
    }
  }
}

if (!process.env.VITEST) {
  await run();
}
