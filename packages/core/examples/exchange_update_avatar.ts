import { Stagehand } from "../lib/v3/index.js";
import type { Page } from "../lib/v3/types/public/page.js";
import type { LocalBrowserLaunchOptions } from "../lib/v3/types/public/options.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const HOME_URL = "https://exchange.asooai.com";
const LOGIN_URL = `${HOME_URL}/login`;
const DEFAULT_CODE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_ACTION_TIMEOUT_MS = 60 * 1000;
const HUMAN_DELAY_MIN_MS = 1_000;
const HUMAN_DELAY_MAX_MS = 2_000;

type CliOptions = {
  account: string;
  avatarPath: string;
  xlsxPath: string;
  codeFilePath: string;
  cacheDir: string;
  usePersistentProfile: boolean;
  codeTimeoutMs: number;
  pollIntervalMs: number;
  headless: boolean;
  closeOnError: boolean;
};

type AccountRecord = {
  account: string;
  password: string;
  rowIndex: number;
};

type WaitResult<T> = {
  value: T;
  elapsedMs: number;
};

type LoginStatus = {
  url: string;
  title: string;
  hasUsernameInput: boolean;
  hasPasswordInput: boolean;
  hasOtpInput: boolean;
  hasHeader: boolean;
  hasSidebar: boolean;
  isLoading: boolean;
  loginButtonText: string;
  bodyExcerpt: string;
  probableError: string | null;
};

type ViewportSize = {
  width: number;
  height: number;
};

function resolveStagehandModel(): string {
  return (
    process.env.STAGEHAND_MODEL_NAME ??
    process.env.STAGEHAND_MODEL ??
    "openai/gpt-4.1-mini"
  );
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanPause(page: Page, actionLabel: string): Promise<void> {
  const delayMs = randomInt(HUMAN_DELAY_MIN_MS, HUMAN_DELAY_MAX_MS);
  console.log(`Human-like pause before ${actionLabel}: ${delayMs}ms`);
  await page.waitForTimeout(delayMs);
}

function parseBooleanFlag(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(normalized);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePreferredViewport(): ViewportSize {
  try {
    if (process.platform === "darwin") {
      const output = execFileSync(
        "python3",
        [
          "-c",
          [
            "from AppKit import NSScreen",
            "screen = NSScreen.mainScreen() or NSScreen.screens()[0]",
            "frame = screen.frame()",
            "print(f\"{int(frame.size.width)},{int(frame.size.height)}\")",
          ].join("; "),
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      const numbers = output
        .split(",")
        .map((value) => parsePositiveInt(value.trim(), 0));
      if (numbers.length === 2 && numbers[0] > 0 && numbers[1] > 0) {
        return {
          width: numbers[0],
          height: numbers[1],
        };
      }
    }

    if (process.platform === "linux") {
      const output = execFileSync(
        "sh",
        ["-lc", "xrandr | grep '\\*' | head -n1"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      const match = output.match(/(\d+)x(\d+)/);
      if (match) {
        return {
          width: parsePositiveInt(match[1], 1920),
          height: parsePositiveInt(match[2], 1080),
        };
      }
    }

    if (process.platform === "win32") {
      const output = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width.ToString() + ',' + [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height.ToString()",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      const [widthRaw, heightRaw] = output.split(",");
      return {
        width: parsePositiveInt(widthRaw, 1920),
        height: parsePositiveInt(heightRaw, 1080),
      };
    }
  } catch {
    // Fall through to default viewport below.
  }

  return {
    width: 1920,
    height: 1080,
  };
}

function normalizeCliKey(raw: string): string {
  return raw.replace(/^-+/, "").trim();
}

function parseCliArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const [rawKey, inlineValue] = token.split("=", 2);
    const key = normalizeCliKey(rawKey);
    if (!key) {
      continue;
    }

    if (inlineValue !== undefined) {
      result[key] = inlineValue;
      continue;
    }

    const nextToken = argv[index + 1];
    if (!nextToken || nextToken.startsWith("--")) {
      result[key] = "true";
      continue;
    }

    result[key] = nextToken;
    index += 1;
  }

  return result;
}

function resolveCandidatePath(
  explicitPath: string | undefined,
  filenames: string[],
): string {
  const candidates = [
    explicitPath,
    ...filenames.flatMap((filename) => [
      path.join(os.homedir(), "下载", filename),
      path.join(os.homedir(), "Downloads", filename),
      path.resolve(process.cwd(), "下载", filename),
      path.resolve(process.cwd(), "Downloads", filename),
    ]),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  }

  throw new Error(
    [
      "Could not find the required file.",
      ...candidates.map((candidate) => `- ${path.resolve(candidate)}`),
    ].join("\n"),
  );
}

function resolveCodeFilePath(explicitPath: string | undefined): string {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const candidates = [
    path.join(os.homedir(), "下载", "ex-code.txt"),
    path.join(os.homedir(), "Downloads", "ex-code.txt"),
    path.resolve(process.cwd(), "下载", "ex-code.txt"),
    path.resolve(process.cwd(), "Downloads", "ex-code.txt"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return candidates[0];
}

function resolveOptions(): CliOptions {
  const args = parseCliArgs(process.argv.slice(2));
  const account = args.account?.trim();
  const avatarArg = args.avatar?.trim();

  if (!account) {
    throw new Error("Missing required argument: --account");
  }

  if (!avatarArg) {
    throw new Error("Missing required argument: --avatar");
  }

  const avatarPath = path.resolve(avatarArg);
  if (!fs.existsSync(avatarPath) || !fs.statSync(avatarPath).isFile()) {
    throw new Error(`Avatar file does not exist: ${avatarPath}`);
  }

  return {
    account,
    avatarPath,
    xlsxPath: resolveCandidatePath(args.xlsx, ["test.xlsx"]),
    codeFilePath: resolveCodeFilePath(args["code-file"]?.trim()),
    cacheDir: path.resolve(
      args["cache-dir"]?.trim() ||
        process.env.EXCHANGE_STAGEHAND_CACHE_DIR ||
        path.join(process.cwd(), "act-cache", "exchange-update-avatar"),
    ),
    usePersistentProfile: parseBooleanFlag(
      args["persistent-profile"] ??
        process.env.EXCHANGE_STAGEHAND_PERSISTENT_PROFILE,
      false,
    ),
    codeTimeoutMs: parsePositiveInt(
      args["code-timeout-ms"],
      DEFAULT_CODE_TIMEOUT_MS,
    ),
    pollIntervalMs: parsePositiveInt(
      args["poll-ms"],
      DEFAULT_POLL_INTERVAL_MS,
    ),
    headless: parseBooleanFlag(args.headless, false),
    closeOnError: parseBooleanFlag(args["close-on-error"], false),
  };
}

function runPythonJson<T>(script: string, args: string[]): T {
  const output = execFileSync("python3", ["-c", script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output) as T;
}

function readXlsxRows(xlsxPath: string): string[][] {
  const pythonScript = String.raw`
import json
import sys
import zipfile
import xml.etree.ElementTree as ET

ns = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main", "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships", "pr": "http://schemas.openxmlformats.org/package/2006/relationships"}

def col_to_index(cell_ref: str) -> int:
    letters = ""
    for char in cell_ref:
        if char.isalpha():
            letters += char
        else:
            break
    result = 0
    for char in letters.upper():
        result = result * 26 + (ord(char) - 64)
    return max(0, result - 1)

def get_cell_value(cell, shared_strings):
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.findall(".//a:t", ns))
    value_node = cell.find("a:v", ns)
    if value_node is None or value_node.text is None:
        return ""
    raw = value_node.text
    if cell_type == "s":
        try:
            return shared_strings[int(raw)]
        except Exception:
            return raw
    return raw

with zipfile.ZipFile(sys.argv[1]) as archive:
    shared_strings = []
    if "xl/sharedStrings.xml" in archive.namelist():
        shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
        for item in shared_root.findall("a:si", ns):
            shared_strings.append("".join(node.text or "" for node in item.findall(".//a:t", ns)))

    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    relations = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    relation_map = {}
    for relation in relations.findall("pr:Relationship", ns):
        relation_map[relation.attrib["Id"]] = relation.attrib["Target"]

    sheets = workbook.findall("a:sheets/a:sheet", ns)
    if not sheets:
        print("[]")
        raise SystemExit(0)

    first_sheet = sheets[0]
    relation_id = first_sheet.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
    target = relation_map.get(relation_id, "")
    if not target.startswith("xl/"):
        target = "xl/" + target

    sheet = ET.fromstring(archive.read(target))
    rows = []
    for row in sheet.findall("a:sheetData/a:row", ns):
        indexed_values = {}
        max_index = -1
        for cell in row.findall("a:c", ns):
            ref = cell.attrib.get("r", "")
            index = col_to_index(ref)
            indexed_values[index] = str(get_cell_value(cell, shared_strings)).strip()
            max_index = max(max_index, index)
        values = ["" for _ in range(max_index + 1)]
        for index, value in indexed_values.items():
            values[index] = value
        rows.append(values)

    print(json.dumps(rows, ensure_ascii=False))
`;

  return runPythonJson<string[][]>(pythonScript, [xlsxPath]);
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_\-:：]/g, "");
}

function isEmptyRow(row: string[]): boolean {
  return row.every((cell) => !cell || !cell.trim());
}

function detectHeaderRow(row: string[]): boolean {
  const normalized = row.map(normalizeText).filter(Boolean);
  const accountHeaders = new Set([
    "账号",
    "用户名",
    "账户",
    "用户",
    "account",
    "username",
    "user",
    "email",
    "邮箱",
    "手机号",
    "手机",
    "phone",
    "telephone",
    "登录账号",
    "登录名",
  ]);
  const passwordHeaders = new Set(["密码", "password", "pass", "pwd"]);

  return (
    normalized.some((value) => accountHeaders.has(value)) &&
    normalized.some((value) => passwordHeaders.has(value))
  );
}

function pickIndex(headers: string[], candidates: string[]): number {
  const normalizedHeaders = headers.map(normalizeText);
  for (const candidate of candidates) {
    const index = normalizedHeaders.indexOf(normalizeText(candidate));
    if (index !== -1) {
      return index;
    }
  }
  return -1;
}

function resolveAccountRecord(
  xlsxPath: string,
  accountSelector: string,
): AccountRecord {
  const rows = readXlsxRows(xlsxPath).filter((row) => !isEmptyRow(row));
  if (rows.length === 0) {
    throw new Error(`No rows were found in ${xlsxPath}`);
  }

  const hasHeader = detectHeaderRow(rows[0]);
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const headers = hasHeader ? rows[0] : [];
  const desiredAccount = accountSelector.trim();
  const byIndex = Number.parseInt(desiredAccount, 10);

  const accountIndex = hasHeader
    ? pickIndex(headers, [
        "账号",
        "用户名",
        "账户",
        "用户",
        "account",
        "username",
        "email",
        "手机号",
        "telephone",
      ])
    : 0;
  const passwordIndex = hasHeader
    ? pickIndex(headers, ["密码", "password", "pass", "pwd"])
    : 1;

  if (passwordIndex === -1) {
    throw new Error(
      `Could not identify the password column in ${xlsxPath}. Please ensure the header contains 密码 or password.`,
    );
  }

  const matchByValue = dataRows.find((row) => {
    if (accountIndex !== -1 && row[accountIndex]?.trim() === desiredAccount) {
      return true;
    }
    return row.some((cell) => cell.trim() === desiredAccount);
  });

  const matchByIndex =
    Number.isFinite(byIndex) && byIndex > 0 ? dataRows[byIndex - 1] : undefined;
  const match = matchByValue ?? matchByIndex;

  if (!match) {
    throw new Error(
      `Could not find account "${desiredAccount}" in ${xlsxPath}. You can pass either the account value or a 1-based row number.`,
    );
  }

  const accountValue =
    (accountIndex !== -1 ? match[accountIndex] : match[0])?.trim() ?? "";
  const passwordValue = match[passwordIndex]?.trim() ?? "";

  if (!accountValue || !passwordValue) {
    throw new Error(
      `The matched row is missing the account or password value in ${xlsxPath}.`,
    );
  }

  return {
    account: accountValue,
    password: passwordValue,
    rowIndex: dataRows.indexOf(match) + 1,
  };
}

async function waitFor<T>(
  page: Page,
  label: string,
  timeoutMs: number,
  pollIntervalMs: number,
  task: () => Promise<T | null>,
): Promise<WaitResult<T>> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = await task();
    if (value !== null) {
      return {
        value,
        elapsedMs: Date.now() - startedAt,
      };
    }
    await page.waitForTimeout(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for ${label}.`);
}

function readOtpFromJobInput(): string | null {
  const inputJsonPath = process.env.AUTOMATION_JOB_INPUT_JSON;
  if (!inputJsonPath || !fs.existsSync(inputJsonPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(inputJsonPath, "utf8").trim();
    if (!content) {
      return null;
    }

    const parsed = JSON.parse(content) as Record<string, unknown>;
    const candidateKeys = [
      "code",
      "otp",
      "otpCode",
      "googleCode",
      "googleAuthCode",
      "verificationCode",
    ];

    for (const key of candidateKeys) {
      const value = parsed[key];
      if (typeof value !== "string" || !value.trim()) {
        continue;
      }

      const code = value.match(/\d{6}/)?.[0] ?? value.trim();
      const nextPayload = { ...parsed };
      delete nextPayload[key];
      fs.writeFileSync(inputJsonPath, JSON.stringify(nextPayload, null, 2), "utf8");
      return code;
    }
  } catch {
    return null;
  }

  return null;
}

async function waitForOtpCode(
  page: Page,
  _filePath: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<string> {
  const startedAt = Date.now();
  let pollCount = 0;

  while (Date.now() - startedAt < timeoutMs) {
    pollCount += 1;

    const jobInputCode = readOtpFromJobInput();
    if (jobInputCode) {
      return jobInputCode;
    }

    if (pollCount % 5 === 0) {
      const inputJsonPath = process.env.AUTOMATION_JOB_INPUT_JSON;
      if (inputJsonPath) {
        console.log(`Waiting for OTP code in job input ${inputJsonPath}...`);
      } else {
        console.log(
          "Waiting for OTP code in job input, but AUTOMATION_JOB_INPUT_JSON is missing.",
        );
      }
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  throw new Error("Timed out waiting for OTP code from job input.");
}

async function bodyText(
  page: Page,
): Promise<string> {
  return await page.evaluate(() => document.body?.innerText ?? "");
}

async function isLoginPage(
  page: Page,
): Promise<boolean> {
  if (page.url().includes("/login")) {
    return true;
  }

  return await page.evaluate(() => {
    const username = document.querySelector(
      'input[placeholder="请输入用户名"]',
    );
    const password = document.querySelector(
      'input[placeholder="请输入密码"]',
    );
    const otp = document.querySelector('input[data-input-otp="true"]');
    return Boolean(username && password && otp);
  });
}

async function readLoginStatus(page: Page): Promise<LoginStatus> {
  return await page.evaluate(() => {
    const body = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
    const knownErrors = [
      "验证码错误",
      "谷歌验证码错误",
      "Google验证码错误",
      "登录失败",
      "用户名或密码错误",
      "账号或密码错误",
      "请求失败",
      "网络错误",
      "您的登录已过期，请重新登录",
    ];
    const probableError = knownErrors.find((item) => body.includes(item)) ?? null;
    const loginButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("登录"),
    );

    return {
      url: window.location.href,
      title: document.title,
      hasUsernameInput: Boolean(
        document.querySelector('input[placeholder="请输入用户名"]'),
      ),
      hasPasswordInput: Boolean(
        document.querySelector('input[placeholder="请输入密码"]'),
      ),
      hasOtpInput: Boolean(document.querySelector('input[data-input-otp="true"]')),
      hasHeader: Boolean(document.querySelector("header")),
      hasSidebar: Boolean(document.querySelector("aside")),
      isLoading: body.includes("正在加载"),
      loginButtonText: loginButton?.textContent?.trim() ?? "",
      bodyExcerpt: body.slice(0, 240),
      probableError,
    };
  });
}

type SessionState = "login" | "dashboard" | "loading" | "unknown";

function deriveSessionState(status: LoginStatus): SessionState {
  if (
    status.url.includes("/login") ||
    status.hasUsernameInput ||
    status.hasPasswordInput ||
    status.hasOtpInput
  ) {
    return "login";
  }

  if (status.hasHeader || status.hasSidebar) {
    return "dashboard";
  }

  if (status.isLoading) {
    return "loading";
  }

  return "unknown";
}

async function waitForSessionState(
  page: Page,
  label: string,
  allowedStates: SessionState[],
  timeoutMs: number,
): Promise<LoginStatus> {
  const startedAt = Date.now();
  let pollCount = 0;

  while (Date.now() - startedAt < timeoutMs) {
    pollCount += 1;
    const status = await readLoginStatus(page);
    const state = deriveSessionState(status);

    if (allowedStates.includes(state)) {
      return status;
    }

    if (status.probableError) {
      throw new Error(
        `${label} failed: ${status.probableError}. url=${status.url} body=${status.bodyExcerpt}`,
      );
    }

    if (pollCount % 5 === 0) {
      console.log(
        `Waiting for ${label}. state=${state} url=${status.url} title=${status.title} body=${status.bodyExcerpt}`,
      );
    }

    await page.waitForTimeout(500);
  }

  const finalStatus = await readLoginStatus(page);
  const finalState = deriveSessionState(finalStatus);
  throw new Error(
    `Timed out waiting for ${label}. state=${finalState} url=${finalStatus.url} title=${finalStatus.title} body=${finalStatus.bodyExcerpt}`,
  );
}

async function clickWithStagehandFallback(
  stagehand: Stagehand,
  page: Page,
  instructions: string[],
): Promise<void> {
  for (const instruction of instructions) {
    const actions = await stagehand.observe(instruction, { page });
    if (actions[0]) {
      await humanPause(page, instruction);
      await stagehand.act(actions[0], {
        page,
        timeout: DEFAULT_ACTION_TIMEOUT_MS,
      });
      return;
    }
  }

  throw new Error(
    `Could not find an action for any of these instructions: ${instructions.join(" | ")}`,
  );
}

async function openManageInfoModal(
  stagehand: Stagehand,
  page: Page,
): Promise<void> {
  await waitForSessionState(
    page,
    "dashboard readiness before opening the avatar menu",
    ["dashboard"],
    DEFAULT_ACTION_TIMEOUT_MS,
  );

  const waitForManageInfoMenu = async (timeoutMs: number): Promise<boolean> => {
    try {
      await waitFor(page, "the account dropdown menu", timeoutMs, 250, async () => {
        const text = await bodyText(page);
        return text.includes("修改管理信息") ? true : null;
      });
      return true;
    } catch {
      return false;
    }
  };

  const waitForManageInfoDialog = async (timeoutMs: number): Promise<boolean> => {
    try {
      await waitFor(page, "the manage info dialog", timeoutMs, 250, async () => {
        const hasFileInput = await page
          .locator('input[type="file"][accept="image/*"]')
          .count();
        return hasFileInput > 0 ? true : null;
      });
      return true;
    } catch {
      return false;
    }
  };

  const directAvatarClick = async () => {
    await humanPause(page, "clicking the top-right avatar trigger");
    return await page.evaluate(() => {
      const avatarTrigger = document.querySelector(
        ".transition-transform.cursor-pointer",
      );
      if (!(avatarTrigger instanceof HTMLElement)) {
        return false;
      }
      avatarTrigger.click();
      return true;
    });
  };

  const avatarClicked = await directAvatarClick();
  const menuOpened = avatarClicked
    ? await waitForManageInfoMenu(2_000)
    : false;

  if (!menuOpened) {
    await clickWithStagehandFallback(stagehand, page, [
      "click the user avatar in the top right corner",
      "click the profile avatar in the top right header",
      "click the top right avatar button",
    ]);
  }

  if (!(await waitForManageInfoMenu(DEFAULT_ACTION_TIMEOUT_MS))) {
    throw new Error("Could not open the account dropdown menu.");
  }

  const clickedManageInfo = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("div, button, a"));
    const target = candidates.find(
      (element) => element.textContent?.trim() === "修改管理信息",
    );
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    target.click();
    return true;
  });

  const dialogOpened = clickedManageInfo
    ? await waitForManageInfoDialog(2_000)
    : false;

  if (!dialogOpened) {
    await clickWithStagehandFallback(stagehand, page, [
      "click 修改管理信息 in the account dropdown menu",
      "click the 修改管理信息 option",
    ]);
  } else {
    await humanPause(page, "opening the 修改管理信息 dialog");
  }

  if (!(await waitForManageInfoDialog(DEFAULT_ACTION_TIMEOUT_MS))) {
    throw new Error("Could not open the 修改管理信息 dialog.");
  }
}

async function getAvatarPreviewSrc(
  page: Page,
): Promise<string | null> {
  return await page.evaluate(() => {
    const input = document.querySelector('input[type="file"][accept="image/*"]');
    if (!(input instanceof HTMLInputElement)) {
      return null;
    }
    const container = input.nextElementSibling;
    if (!(container instanceof HTMLElement)) {
      return null;
    }
    const image = container.querySelector("img");
    if (!(image instanceof HTMLImageElement)) {
      return null;
    }
    return image.currentSrc || image.src || null;
  });
}

async function removeExistingAvatarIfPresent(
  page: Page,
): Promise<boolean> {
  await humanPause(page, "removing the existing avatar");
  return await page.evaluate(() => {
    const input = document.querySelector('input[type="file"][accept="image/*"]');
    if (!(input instanceof HTMLInputElement)) {
      return false;
    }
    const container = input.nextElementSibling;
    if (!(container instanceof HTMLElement)) {
      return false;
    }

    const removeButton = container.querySelector(
      ".absolute.top-1.right-1.z-50, .absolute.top-1.right-1",
    );
    if (!(removeButton instanceof HTMLElement)) {
      return false;
    }

    removeButton.click();
    return true;
  });
}

async function waitForAvatarUpload(
  page: Page,
  previousSrc: string | null,
): Promise<void> {
  await page.waitForTimeout(500);

  await waitFor(
    page,
    "avatar upload to finish",
    DEFAULT_ACTION_TIMEOUT_MS,
    500,
    async () => {
      const state = await page.evaluate(() => {
        const input = document.querySelector(
          'input[type="file"][accept="image/*"]',
        );
        if (!(input instanceof HTMLInputElement)) {
          return null;
        }
        const container = input.nextElementSibling;
        if (!(container instanceof HTMLElement)) {
          return null;
        }
        const text = container.innerText ?? "";
        const image = container.querySelector("img");
        return {
          uploading: text.includes("上传中"),
          failed: text.includes("上传失败"),
          currentSrc:
            image instanceof HTMLImageElement
              ? image.currentSrc || image.src || ""
              : "",
        };
      });

      if (!state) {
        return null;
      }

      if (state.failed) {
        throw new Error("Avatar upload failed. The page shows 上传失败.");
      }

      if (state.uploading) {
        return null;
      }

      if (!state.currentSrc) {
        return null;
      }

      if (!previousSrc || state.currentSrc !== previousSrc) {
        return true;
      }

      return null;
    },
  );
}

async function uploadAvatar(
  page: Page,
  avatarPath: string,
): Promise<void> {
  const previousSrc = await getAvatarPreviewSrc(page);
  const removed = await removeExistingAvatarIfPresent(page);
  if (removed) {
    await page.waitForTimeout(300);
  }

  const fileInput = page.locator('input[type="file"][accept="image/*"]').first();
  await humanPause(page, "uploading the new avatar");
  await fileInput.setInputFiles(avatarPath);
  await waitForAvatarUpload(page, previousSrc);
}

async function submitManageInfo(
  page: Page,
): Promise<void> {
  await humanPause(page, "submitting the manage info form");
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const submitButton = buttons.find(
      (button) => button.textContent?.trim() === "提交",
    );
    if (!(submitButton instanceof HTMLButtonElement)) {
      return false;
    }
    submitButton.click();
    return true;
  });

  if (!clicked) {
    throw new Error("Could not find the 提交 button in the manage info dialog.");
  }

  await waitFor(
    page,
    "the success toast after submit",
    DEFAULT_ACTION_TIMEOUT_MS,
    500,
    async () => {
      const text = await bodyText(page);
      return text.includes("操作成功") ? true : null;
    },
  );
}

async function fillLoginCredentials(
  page: Page,
  account: string,
  password: string,
): Promise<void> {
  await humanPause(page, "typing the username");
  await page.locator('input[placeholder="请输入用户名"]').first().fill(account);
  await humanPause(page, "typing the password");
  await page.locator('input[placeholder="请输入密码"]').first().fill(password);
}

async function fillOtpAndSubmitLogin(
  page: Page,
  otpCode: string,
): Promise<void> {
  await humanPause(page, "typing the OTP code");
  await page.locator('input[data-input-otp="true"]').first().fill(otpCode);

  await humanPause(page, "clicking the login button");
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const loginButton = buttons.find(
      (button) => button.textContent?.trim() === "登录",
    );
    if (!(loginButton instanceof HTMLButtonElement)) {
      return false;
    }
    loginButton.click();
    return true;
  });

  if (!clicked) {
    throw new Error("Could not find the 登录 button on the login page.");
  }
}

async function ensureLoggedIn(
  page: Page,
  record: AccountRecord,
  options: CliOptions,
): Promise<void> {
  await page.goto(HOME_URL, {
    waitUntil: "load",
    timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
  });

  const initialStatus = await waitForSessionState(
    page,
    "the initial app state",
    ["login", "dashboard"],
    15_000,
  );

  if (deriveSessionState(initialStatus) === "dashboard") {
    console.log("Detected an existing logged-in session.");
    return;
  }

  console.log(
    `Login page detected. Using account "${record.account}" from row ${record.rowIndex}.`,
  );

  await page.goto(LOGIN_URL, {
    waitUntil: "load",
    timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
  });

  await fillLoginCredentials(page, record.account, record.password);

  const otpCode = await waitForOtpCode(
    page,
    options.codeFilePath,
    options.codeTimeoutMs,
    options.pollIntervalMs,
  );
  console.log(`Read OTP code from ${options.codeFilePath}.`);

  await fillOtpAndSubmitLogin(page, otpCode);
  await waitForSessionState(
    page,
    "login to finish",
    ["dashboard"],
    DEFAULT_ACTION_TIMEOUT_MS,
  );
}

async function runAvatarFlow(
  stagehand: Stagehand,
  options: CliOptions,
): Promise<void> {
  const record = resolveAccountRecord(options.xlsxPath, options.account);
  const page = stagehand.context.pages()[0];

  console.log(`Excel file: ${options.xlsxPath}`);
  console.log(`Code file: ${options.codeFilePath}`);
  console.log(`Avatar file: ${options.avatarPath}`);
  console.log(`Cache dir: ${options.cacheDir}`);
  console.log(
    `Browser session mode: ${options.usePersistentProfile ? "persistent-profile" : "temporary-session"}`,
  );

  await ensureLoggedIn(page, record, options);
  await openManageInfoModal(stagehand, page);
  await uploadAvatar(page, options.avatarPath);
  await submitManageInfo(page);
}

(async () => {
  const options = resolveOptions();
  const viewport = resolvePreferredViewport();
  const profileDirectory = process.env.EXCHANGE_STAGEHAND_PROFILE_DIRECTORY;
  const userDataDir = process.env.EXCHANGE_STAGEHAND_PROFILE_DIR;
  const localBrowserLaunchOptions: LocalBrowserLaunchOptions = {
    headless: options.headless,
    viewport,
    deviceScaleFactor: 1,
    args: [
      "--window-position=0,0",
      `--window-size=${viewport.width},${viewport.height}`,
    ],
  };

  if (options.usePersistentProfile) {
    const resolvedProfileDirectory = profileDirectory ?? "Default";
    const resolvedUserDataDir =
      userDataDir ?? path.resolve(process.cwd(), ".profiles", "exchange-avatar");

    fs.mkdirSync(path.join(resolvedUserDataDir, resolvedProfileDirectory), {
      recursive: true,
    });

    localBrowserLaunchOptions.userDataDir = resolvedUserDataDir;
    localBrowserLaunchOptions.preserveUserDataDir = true;
    localBrowserLaunchOptions.args = [
      "--window-position=0,0",
      `--window-size=${viewport.width},${viewport.height}`,
      `--profile-directory=${resolvedProfileDirectory}`,
    ];
  }

  const stagehand = new Stagehand({
    env: "LOCAL",
    model: resolveStagehandModel(),
    verbose: 1,
    cacheDir: options.cacheDir,
    localBrowserLaunchOptions,
  });

  let succeeded = false;

  try {
    if (options.usePersistentProfile) {
      console.log(
        `Using browser profile: ${localBrowserLaunchOptions.userDataDir}/${profileDirectory ?? "Default"}`,
      );
    } else {
      console.log("Using a temporary browser session.");
    }
    console.log(`Using viewport: ${viewport.width}x${viewport.height}`);
    await stagehand.init();
    await runAvatarFlow(stagehand, options);
    succeeded = true;
    console.log("Avatar updated successfully. Closing browser.");
  } catch (error) {
    console.error(
      "Avatar update failed. The browser will remain open for debugging unless --close-on-error=true is set.",
    );
    throw error;
  } finally {
    if (succeeded || options.closeOnError) {
      await stagehand.close().catch(() => {});
    }
  }
})();
