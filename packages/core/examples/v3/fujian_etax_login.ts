import fs from "node:fs";
import path from "node:path";
import { Stagehand } from "@browserbasehq/stagehand";
import { AISdkClient } from "../../lib/v3/llm/aisdk.js";
import { getAISDKLanguageModel } from "../../lib/v3/llm/LLMProvider.js";
import {
  buildCaptchaAgentInstruction,
  CAPTCHA_AGENT_EXCLUDED_TOOLS,
  CAPTCHA_MAX_ATTEMPTS,
  clickFirstVisibleSelector,
  clickVisibleTextButton,
  fillFirstMatchingSelector,
  FUJIAN_ETAX_URL,
  getCaptchaAttemptOutcome,
  getVisibleTextMatches,
  humanPause,
  isCaptchaDialogVisible,
  isLoginPageVisible,
  observeAndActAny,
  pageHasVisibleText,
  waitForCaptchaDialog,
  waitForCaptchaToResolve,
  waitForCondition,
  waitForLoginPage,
} from "../../lib/v3/examples/fujianEtaxLogin.js";

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
const captchaAgentModel =
  captchaModel.startsWith("newapi/")
    ? {
        modelName: captchaModel,
        apiKey: process.env.NEWAPI_API_KEY,
        baseURL: process.env.NEWAPI_BASE_URL,
      }
    : captchaModel;
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

async function solveCaptcha(stagehand: Stagehand): Promise<void> {
  const page = stagehand.context.pages()[0];
  const captchaShown = await waitForCaptchaDialog(page);

  if (!captchaShown) {
    console.log("No captcha dialog detected after login submit. Stopping.");
    return;
  }

  console.log(
    "Captcha agent config:",
    JSON.stringify(
      typeof captchaAgentModel === "string"
        ? {
            model: captchaAgentModel,
            apiKeyPresent: false,
            baseURLPresent: false,
          }
        : {
            model: captchaAgentModel.modelName,
            apiKeyPresent: Boolean(captchaAgentModel.apiKey),
            baseURLPresent: Boolean(captchaAgentModel.baseURL),
          },
      null,
      2,
    ),
  );

  const captchaAgent = stagehand.agent({
    mode: "hybrid",
    model: captchaAgentModel,
  });

  for (let attempt = 1; attempt <= CAPTCHA_MAX_ATTEMPTS; attempt += 1) {
    await humanPause(page, `starting captcha attempt ${attempt}`);
    console.log(`Captcha attempt ${attempt}/${CAPTCHA_MAX_ATTEMPTS}`);

    try {
      const result = await captchaAgent.execute({
        instruction: buildCaptchaAgentInstruction(),
        page,
        maxSteps: 7,
        highlightCursor: true,
        toolTimeout: 45_000,
        excludeTools: CAPTCHA_AGENT_EXCLUDED_TOOLS,
      });
      console.log(`Captcha agent result: ${result.message}`);
    } catch (error) {
      console.warn(`Captcha hybrid agent failed on attempt ${attempt}:`, error);
    }

    const solved = await waitForCaptchaToResolve(page);
    const outcome = getCaptchaAttemptOutcome(!solved, attempt);

    if (outcome === "solved") {
      console.log("Captcha dialog disappeared. Automation stopping.");
      return;
    }

    if (outcome === "retry") {
      console.log("Captcha still visible. Waiting for the next image and retrying.");
      continue;
    }

    throw new Error("Captcha failed three times. Stopping the automation.");
  }
}

async function run(): Promise<void> {
  mirrorProcessOutputToLogFile(logFilePath);

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

  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0];

    console.log(`Navigating to ${FUJIAN_ETAX_URL}`);
    await page.goto(FUJIAN_ETAX_URL, { waitUntil: "load" });

    await humanPause(page, "waiting after initial page load");
    await dismissNoticePopupIfNeeded(stagehand);
    await openLoginPage(stagehand);
    await fillCredentialsAndSubmit(stagehand);
    await solveCaptcha(stagehand);

    const captchaVisible = await isCaptchaDialogVisible(page);
    if (captchaVisible) {
      throw new Error("Captcha dialog is still visible after the allowed retries.");
    }
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

await run();
