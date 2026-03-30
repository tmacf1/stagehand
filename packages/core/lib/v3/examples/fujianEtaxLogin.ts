import type { AnyPage, Stagehand } from "@browserbasehq/stagehand";

export const FUJIAN_ETAX_URL = "https://etax.fujian.chinatax.gov.cn:8443/";
export const CAPTCHA_MAX_ATTEMPTS = 3;
export const DEFAULT_DELAY_MIN_MS = 1_000;
export const DEFAULT_DELAY_MAX_MS = 2_000;
export const CAPTCHA_AGENT_EXCLUDED_TOOLS = [
  "goto",
  "navback",
  "search",
  "scroll",
  "keys",
  "type",
  "dragAndDrop",
  "clickAndHold",
  "fillFormVision",
  "act",
  "extract",
  "ariaTree",
];

export type CaptchaAttemptOutcome = "solved" | "retry" | "failed";
type BodyTextEvaluator = {
  evaluate: <T>(pageFunctionOrExpression: string | (() => T)) => Promise<T>;
};

export type VisibleTextMatch = {
  tag: string;
  text: string;
  className: string;
  id: string;
  role: string;
};

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

export function buildCaptchaActInstruction(): string {
  return [
    "在当前验证码验证框中，只执行这一轮验证码操作。",
    "先阅读右上角小图中的文字顺序，",
    "再在下方大图中按相同顺序依次点击对应文字。",
    "全部点击完成后，再点击下方的“确定”按钮。",
    "不要做其他页面操作。",
  ].join("");
}

export function buildCaptchaAgentInstruction(): string {
  return [
    "只处理当前页面里已经打开的验证码弹窗，不要导航、不要刷新、不要离开当前页。",
    "绝对不要点击验证码弹窗外部的页面、遮罩层、空白区域或页面其他控件。",
    "在第一次点击汉字之前，不要提前点击“确定”、刷新、关闭或任何非验证码大图区域。",
    "先读取右上角小图里的汉字顺序，并先数清楚一共有几个字。",
    "请根据小图的汉字顺序，在下方大图中依次找出这些汉字的位置。",
    "请明确使用以下坐标定义：大图左上角就是坐标原点 (0,0)。",
    "x 轴从左向右增大，y 轴从上向下增大，并将整张大图抽象为 1000x1000 的坐标系。",
    "先在心里得到一个按顺序排列的坐标数组，每个汉字只对应一个坐标；如果小图里是4个字，就只返回4个坐标；如果是5个字，就只返回5个坐标。",
    "不要臆测隐藏字、不要补额外坐标、不要因为相似字多返回一个坐标。",
    "得到坐标数组后，只在下方大图的 canvas 可见矩形内部按这些坐标顺序依次点击，点击次数必须和小图中的字数完全一致。",
    "每一个坐标都必须明显落在大图 canvas 内部，不能靠近 canvas 边缘，更不能落到弹窗外部。",
    "每次点击大图中的一个汉字后，都要随机等待 1 到 2 秒，再进行下一次点击，模拟人的操作节奏。",
    "完成与字数完全一致的坐标点击后，再随机等待 1 到 2 秒，然后点击“确定”按钮。",
    "只有在完成全部汉字点击后，才能点击“确定”按钮。",
    "点击“确定”后必须立刻结束这一轮并调用 done，不要再点击刷新、关闭、返回或任何其他按钮，也不要观察失败结果后自行重试。",
    "如果验证码弹窗在任何汉字点击之前就消失，视为误操作，不要宣称成功。",
    "如果无法确认下一个字，就停止，不要额外点击。",
  ].join("");
}

export function isTextMatch(actual: string, expected: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, "");
  return normalize(actual) === normalize(expected);
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

export async function pageContainsText(
  page: AnyPage,
  text: string,
): Promise<boolean> {
  return (await bodyText(page)).includes(text);
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
  page: AnyPage,
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

export async function waitForLoginPage(page: AnyPage): Promise<void> {
  const found = await waitForCondition(page, 15_000, 500, async () => {
    return await isLoginPageVisible(page);
  });

  if (!found) {
    throw new Error("Timed out waiting for the Fujian eTax login page.");
  }
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

export async function findAction(
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
