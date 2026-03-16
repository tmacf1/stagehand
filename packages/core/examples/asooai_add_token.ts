import { Stagehand } from "../lib/v3/index.js";
import fs from "node:fs";
import path from "node:path";

async function observeAndAct(
  stagehand: Stagehand,
  instruction: string,
): Promise<void> {
  const [action] = await stagehand.observe(instruction);
  if (!action) {
    throw new Error(`No action found for instruction: ${instruction}`);
  }
  await stagehand.act(action, { timeout: 30_000 });
}

async function findAction(
  stagehand: Stagehand,
  instructions: string[],
) {
  for (const instruction of instructions) {
    const [action] = await stagehand.observe(instruction);
    if (action) {
      return { action, instruction };
    }
  }
  return null;
}

async function observeAndActAny(
  stagehand: Stagehand,
  instructions: string[],
): Promise<void> {
  const match = await findAction(stagehand, instructions);
  if (!match) {
    throw new Error(
      `No action found for instructions: ${instructions.join(" | ")}`,
    );
  }
  await stagehand.act(match.action, { timeout: 3_000 });
}

async function hasLoginForm(stagehand: Stagehand): Promise<boolean> {
  const page = stagehand.context.pages()[0];
  const passwordFieldCount = await page.locator('input[type="password"]').count();
  return passwordFieldCount > 0;
}

async function hasConsoleAction(stagehand: Stagehand): Promise<boolean> {
  const actions = await stagehand.observe(
    "find the 控制台 menu item in the top navigation",
  );
  return actions.length > 0;
}

async function hasTokenManagementAction(stagehand: Stagehand): Promise<boolean> {
  const actions = await stagehand.observe(
    "find the 令牌管理 item in the left sidebar",
  );
  return actions.length > 0;
}

async function waitForAutomaticLogin(stagehand: Stagehand): Promise<void> {
  const page = stagehand.context.pages()[0];
  const maxWaitMs = 10 * 60 * 1000;
  const pollMs = 1_500;
  const stableSuccessChecksNeeded = 3;
  const startedAt = Date.now();
  let stableSuccessChecks = 0;
  let pollCount = 0;

  console.log(
    "Login page detected in the dedicated Stagehand profile. Complete the login manually in the opened browser window.",
  );
  console.log(
    "The script is now watching for a stable console session and will continue automatically after login succeeds.",
  );

  while (Date.now() - startedAt < maxWaitMs) {
    pollCount += 1;
    const [loginFormVisible, consoleReady, tokenManagementReady] =
      await Promise.all([
        hasLoginForm(stagehand),
        hasConsoleAction(stagehand),
        hasTokenManagementAction(stagehand),
      ]);
    const onConsolePage = page.url().includes("/console");
    const loginSucceeded =
      !loginFormVisible && (tokenManagementReady || onConsolePage);

    if (loginSucceeded) {
      stableSuccessChecks += 1;
      if (stableSuccessChecks >= stableSuccessChecksNeeded) {
        console.log("Login confirmed. Continuing with console navigation flow.");
        return;
      }
    } else {
      stableSuccessChecks = 0;
    }

    if (pollCount % 5 === 0) {
      console.log(
        `Waiting for login to finish. url=${page.url()} loginFormVisible=${loginFormVisible} consoleReady=${consoleReady} tokenManagementReady=${tokenManagementReady}`,
      );
    }

    await page.waitForTimeout(pollMs);
  }

  throw new Error(
    "Timed out waiting for login to succeed in the dedicated Stagehand profile.",
  );
}

async function example(stagehand: Stagehand) {
  const page = stagehand.context.pages()[0];

  await page.goto("https://asooai.com", {
    waitUntil: "load",
  });

  const consoleEntry = await findAction(stagehand, [
    "click the 控制台 menu item in the top navigation",
    "click the 控制台 link in the header",
    "click the 控制台 button",
    "click the button or link that opens the console",
  ]);

  if (consoleEntry) {
    await stagehand.act(consoleEntry.action, { timeout: 30_000 });
  } else {
    await page.goto("https://asooai.com/console", {
      waitUntil: "load",
    });
  }

  if (await hasLoginForm(stagehand)) {
    await waitForAutomaticLogin(stagehand);
    await page.goto("https://asooai.com/console", {
      waitUntil: "load",
    });
  }

  await page.waitForTimeout(1_000);
  await observeAndActAny(stagehand, [
    "click the 令牌管理 item in the left sidebar",
    "click the 令牌 item in the left sidebar",
    "click the token management item in the left sidebar",
  ]);
  await page.waitForTimeout(1_000);
  await observeAndAct(stagehand, "click the 添加令牌 button");
  await stagehand.act("fill the 名称 field with the text 'test'");
  await stagehand.act("click the 令牌分组 dropdown");
  await page.waitForTimeout(1_000);
  await observeAndAct(stagehand, "click the vip option in the opened dropdown");
  await observeAndAct(stagehand, "click the 提交 button");
}

(async () => {
  const profileDirectory =
    process.env.ASOOAI_STAGEHAND_PROFILE_DIRECTORY ??
    process.env.ASOOAI_CHROME_PROFILE_DIRECTORY ??
    "Default";
  const userDataDir =
    process.env.ASOOAI_STAGEHAND_PROFILE_DIR ??
    path.resolve(process.cwd(), ".profiles", "asooai-clone");
  fs.mkdirSync(path.join(userDataDir, profileDirectory), { recursive: true });

  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: {
      userDataDir,
      preserveUserDataDir: true,
      headless: false,
      args: [`--profile-directory=${profileDirectory}`],
    },
    model: process.env.STAGEHAND_MODEL_NAME ?? process.env.STAGEHAND_MODEL,
    verbose: 2,
  });
  const autoClose =
    process.env.ASOOAI_AUTO_CLOSE === "1" ||
    process.env.ASOOAI_AUTO_CLOSE === "true";

  try {
    console.log(`Using dedicated Stagehand profile dir: ${userDataDir}`);
    console.log(`Using profile directory: ${profileDirectory}`);
    console.log(
      "This script no longer copies your real Chrome profile. Log in once in this dedicated Stagehand window, and future runs will reuse that same clone profile.",
    );
    await stagehand.init();
    await example(stagehand);
    if (autoClose) {
      await stagehand.close();
      return;
    }
    console.log(
      "Automation finished. Browser left open for inspection. Set ASOOAI_AUTO_CLOSE=1 to close it automatically.",
    );
  } catch (error) {
    if (!autoClose) {
      console.error(
        "Automation failed. Browser left open for debugging. Set ASOOAI_AUTO_CLOSE=1 to close it automatically.",
      );
    }
    throw error;
  } finally {
    if (!autoClose) {
      return;
    }
    await stagehand.close();
  }
})();
