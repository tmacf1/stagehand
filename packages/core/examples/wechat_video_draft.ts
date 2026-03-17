import { Stagehand } from "../lib/v3/index.js";
import type { Action } from "../lib/v3/types/public/methods.js";
import type { Page } from "../lib/v3/types/public/page.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const HOME_URL = "https://channels.weixin.qq.com";
const DEFAULT_TOPIC = "鹦鹉聪明";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const PAGE_READY_TIMEOUT_MS = 2 * 60 * 1000;
const SAVE_DRAFT_TIMEOUT_MS = 10 * 60 * 1000;
const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".avi",
  ".wmv",
  ".mkv",
  ".webm",
]);

type ActionMatch = {
  action: Action;
  instruction: string;
};

type TextClickRegion = "any" | "left" | "top" | "topLeft";

type TextClickOptions = {
  label: string;
  texts: string[];
  region?: TextClickRegion;
  preferLargest?: boolean;
  preferSmallest?: boolean;
};

type TextClickTarget = {
  x: number;
  y: number;
  text: string;
  tagName: string;
  score: number;
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

function parsePositiveInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolvePreferredViewport(): ViewportSize {
  const envWidth = parsePositiveInt(
    process.env.WECHAT_VIDEO_VIEWPORT_WIDTH ?? "",
  );
  const envHeight = parsePositiveInt(
    process.env.WECHAT_VIDEO_VIEWPORT_HEIGHT ?? "",
  );
  if (envWidth && envHeight) {
    return { width: envWidth, height: envHeight };
  }

  try {
    if (process.platform === "darwin") {
      const output = execFileSync(
        "/usr/bin/osascript",
        ["-e", 'tell application "Finder" to get bounds of window of desktop'],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      const numbers = output
        .split(",")
        .map((value) => parsePositiveInt(value.trim()) ?? 0);
      if (numbers.length === 4 && numbers[2] > 0 && numbers[3] > 0) {
        return {
          width: numbers[2],
          height: numbers[3],
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
        const width = parsePositiveInt(match[1]);
        const height = parsePositiveInt(match[2]);
        if (width && height) {
          return { width, height };
        }
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
      const width = parsePositiveInt(widthRaw ?? "");
      const height = parsePositiveInt(heightRaw ?? "");
      if (width && height) {
        return { width, height };
      }
    }
  } catch {
    // Fall through to the conservative default below.
  }

  return {
    width: 1920,
    height: 1080,
  };
}

function resolveUploadDirectory(): string {
  const explicitPath = process.env.WECHAT_VIDEO_UPLOAD_DIR;
  const candidates = [
    explicitPath,
    path.join(os.homedir(), "Downloads", "dytest"),
    path.join(os.homedir(), "下载", "dytest"),
    path.resolve(process.cwd(), "Downloads", "dytest"),
    path.resolve(process.cwd(), "下载", "dytest"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  throw new Error(
    [
      "Could not find the upload directory.",
      "Set WECHAT_VIDEO_UPLOAD_DIR or create one of these folders:",
      ...candidates.map((candidate) => `- ${candidate}`),
    ].join("\n"),
  );
}

function pickFirstUploadFile(uploadDirectory: string): string {
  const collator = new Intl.Collator("zh-Hans-CN", {
    numeric: true,
    sensitivity: "base",
  });

  const entries = fs
    .readdirSync(uploadDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .sort((left, right) => collator.compare(left.name, right.name));

  if (entries.length === 0) {
    throw new Error(`No files were found in ${uploadDirectory}`);
  }

  const preferredVideo =
    entries.find((entry) =>
      VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
    ) ?? entries[0];

  return path.join(uploadDirectory, preferredVideo.name);
}

async function countText(page: Page, text: string): Promise<number> {
  return await page.evaluate(
    ({ value }) => {
      const bodyText = document.body?.innerText ?? "";
      return bodyText.includes(value) ? 1 : 0;
    },
    { value: text },
  );
}

async function findTextClickTargets(
  page: Page,
  options: TextClickOptions,
): Promise<TextClickTarget[]> {
  return await page.evaluate((input) => {
    try {
      type Candidate = TextClickTarget & { key: string };

      const normalizedTargets = input.texts
        .map((text) => text.replace(/\s+/g, " ").trim())
        .filter(Boolean);

      if (normalizedTargets.length === 0) {
        return [];
      }

      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const seen = new Set<string>();
      const candidates: Candidate[] = [];

      const normalize = (value: string | null | undefined) =>
        (value ?? "").replace(/\s+/g, " ").trim();

      const getView = (element: Element) =>
        element.ownerDocument?.defaultView ?? window;

      const isElementLike = (
        value: Element,
      ): value is Element & Record<string, unknown> =>
        value.nodeType === Node.ELEMENT_NODE;

      const isVisible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) {
          return false;
        }

        const style = getView(element).getComputedStyle(element);
        return !(
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.pointerEvents === "none" ||
          Number(style.opacity || "1") < 0.05
        );
      };

      const isInteractive = (element: Element): boolean => {
        if (!isElementLike(element)) {
          return false;
        }

        const role = normalize(element.getAttribute("role")).toLowerCase();
        const tagName = element.tagName.toLowerCase();
        const style = getView(element).getComputedStyle(element);
        const tabIndex =
          "tabIndex" in element && typeof element.tabIndex === "number"
            ? element.tabIndex
            : -1;

        return (
          role === "button" ||
          role === "link" ||
          ["button", "a", "input", "label", "summary"].includes(tagName) ||
          typeof (element as { onclick?: unknown }).onclick === "function" ||
          tabIndex >= 0 ||
          style.cursor === "pointer"
        );
      };

      const getText = (element: Element): string => {
        const parts: string[] = [
          normalize(
            "innerText" in element
              ? String((element as { innerText?: unknown }).innerText ?? "")
              : "",
          ),
          normalize(element.getAttribute("aria-label")),
          normalize(element.getAttribute("title")),
        ];

        const tagName = element.tagName.toLowerCase();
        if (["input", "button", "textarea"].includes(tagName)) {
          parts.push(
            normalize(
              "value" in element
                ? String((element as { value?: unknown }).value ?? "")
                : "",
            ),
          );
        }

        return normalize(parts.filter(Boolean).join(" "));
      };

      const nearestClickable = (element: Element): Element => {
        let current: Element | null = element;
        for (let index = 0; current && index < 5; index += 1) {
          if (isVisible(current) && isInteractive(current)) {
            return current;
          }
          current = current.parentElement;
        }
        return element;
      };

      const pushCandidate = (
        matchedElement: Element,
        matchedText: string,
        offsetX: number,
        offsetY: number,
      ) => {
        const targetElement = nearestClickable(matchedElement);
        if (!isVisible(targetElement)) {
          return;
        }

        const rect = targetElement.getBoundingClientRect();
        const centerX = offsetX + rect.left + rect.width / 2;
        const centerY = offsetY + rect.top + rect.height / 2;
        if (
          centerX < 0 ||
          centerY < 0 ||
          centerX > viewportWidth ||
          centerY > viewportHeight
        ) {
          return;
        }

        const text = getText(targetElement) || matchedText;
        if (!text || text.length > 160) {
          return;
        }

        const key = [
          targetElement.tagName,
          Math.round(centerX),
          Math.round(centerY),
          text,
        ].join("|");
        if (seen.has(key)) {
          return;
        }
        seen.add(key);

        const normalizedText = normalize(text);
        const exactMatch = normalizedTargets.some(
          (target) => normalizedText === target || matchedText === target,
        );
        const area = rect.width * rect.height;

        let score = exactMatch ? 220 : 150;
        score += isInteractive(targetElement) ? 35 : 0;
        score += ["BUTTON", "A", "LABEL"].includes(targetElement.tagName)
          ? 15
          : 0;
        score -= Math.min(normalizedText.length, 80);

        if (input.preferLargest) {
          score += Math.min(area / 2_500, 80);
        }
        if (input.preferSmallest) {
          score -= Math.min(area / 2_500, 60);
        }

        if (input.region === "left" || input.region === "topLeft") {
          score += centerX < viewportWidth * 0.55 ? 60 : -80;
        }
        if (input.region === "top" || input.region === "topLeft") {
          score += centerY < viewportHeight * 0.55 ? 50 : -70;
        }

        candidates.push({
          key,
          x: centerX,
          y: centerY,
          text: normalizedText,
          tagName: targetElement.tagName,
          score,
        });
      };

      const visitRoot = (
        root: Document | ShadowRoot,
        offsetX: number,
        offsetY: number,
      ) => {
        const elements = Array.from(root.querySelectorAll("*"));
        for (const element of elements) {
          try {
            if (!isVisible(element)) {
              continue;
            }

            const text = getText(element);
            if (text && text.length <= 160) {
              const matchedTarget = normalizedTargets.find((target) =>
                text.includes(target),
              );
              if (matchedTarget) {
                pushCandidate(element, matchedTarget, offsetX, offsetY);
              }
            }

            if (element.shadowRoot) {
              visitRoot(element.shadowRoot, offsetX, offsetY);
            }

            const tagName = element.tagName.toLowerCase();
            if (tagName === "iframe" || tagName === "frame") {
              try {
                const frameDocument = (
                  element as HTMLIFrameElement | HTMLFrameElement
                ).contentDocument;
                if (frameDocument) {
                  const rect = element.getBoundingClientRect();
                  visitRoot(
                    frameDocument,
                    offsetX + rect.left,
                    offsetY + rect.top,
                  );
                }
              } catch {}
            }
          } catch {}
        }
      };

      visitRoot(document, 0, 0);

      candidates.sort((left, right) => right.score - left.score);
      return candidates.map((candidate) => ({
        x: candidate.x,
        y: candidate.y,
        text: candidate.text,
        tagName: candidate.tagName,
        score: candidate.score,
      }));
    } catch {
      return [];
    }
  }, options);
}

async function hasTextTarget(
  page: Page,
  options: TextClickOptions,
): Promise<boolean> {
  const targets = await findTextClickTargets(page, options);
  return targets.length > 0;
}

async function clickTextTarget(
  page: Page,
  options: TextClickOptions,
): Promise<boolean> {
  const [target] = await findTextClickTargets(page, options);
  if (!target) {
    return false;
  }

  console.log(
    `Clicking ${options.label} via text target "${target.text}" (${target.tagName}) at (${Math.round(target.x)}, ${Math.round(target.y)}) score=${target.score.toFixed(1)}`,
  );
  await page.click(target.x, target.y);
  return true;
}

async function clickDomTargetByText(
  page: Page,
  options: TextClickOptions,
): Promise<boolean> {
  return await page.evaluate((input) => {
    const normalizedTargets = input.texts
      .map((text) => text.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (normalizedTargets.length === 0) {
      return false;
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const normalize = (value: string | null | undefined) =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const getView = (element: Element) =>
      element.ownerDocument?.defaultView ?? window;

    const isVisible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) {
        return false;
      }

      const style = getView(element).getComputedStyle(element);
      return !(
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.pointerEvents === "none" ||
        Number(style.opacity || "1") < 0.05
      );
    };

    const isClickable = (element: Element): boolean => {
      const tagName = element.tagName.toLowerCase();
      const role = normalize(element.getAttribute("role")).toLowerCase();
      const style = getView(element).getComputedStyle(element);
      const tabIndex =
        "tabIndex" in element && typeof element.tabIndex === "number"
          ? element.tabIndex
          : -1;

      return (
        role === "button" ||
        role === "link" ||
        ["button", "a", "input", "label", "summary"].includes(tagName) ||
        typeof (element as { onclick?: unknown }).onclick === "function" ||
        tabIndex >= 0 ||
        style.cursor === "pointer"
      );
    };

    const getText = (element: Element): string => {
      const parts: string[] = [
        normalize(
          "innerText" in element
            ? String((element as { innerText?: unknown }).innerText ?? "")
            : "",
        ),
        normalize(element.getAttribute("aria-label")),
        normalize(element.getAttribute("title")),
      ];

      const tagName = element.tagName.toLowerCase();
      if (["input", "button", "textarea"].includes(tagName)) {
        parts.push(
          normalize(
            "value" in element
              ? String((element as { value?: unknown }).value ?? "")
              : "",
          ),
        );
      }

      return normalize(parts.filter(Boolean).join(" "));
    };

    const nearestClickable = (element: Element): HTMLElement | null => {
      let current: Element | null = element;
      for (let index = 0; current && index < 6; index += 1) {
        if (
          current instanceof HTMLElement &&
          isVisible(current) &&
          isClickable(current)
        ) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    };

    const scoreCandidate = (element: HTMLElement): number => {
      const rect = element.getBoundingClientRect();
      const text = getText(element);
      let score = 200 - Math.min(text.length, 80);
      const area = rect.width * rect.height;

      if (input.preferLargest) {
        score += Math.min(area / 2_500, 80);
      }
      if (input.preferSmallest) {
        score -= Math.min(area / 2_500, 60);
      }

      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      if (input.region === "left" || input.region === "topLeft") {
        score += centerX < viewportWidth * 0.55 ? 60 : -80;
      }
      if (input.region === "top" || input.region === "topLeft") {
        score += centerY < viewportHeight * 0.55 ? 50 : -70;
      }

      return score;
    };

    const candidates: Array<{ element: HTMLElement; score: number }> = [];
    const seen = new Set<HTMLElement>();

    const visitRoot = (root: Document | ShadowRoot) => {
      const elements = Array.from(root.querySelectorAll("*"));
      for (const element of elements) {
        try {
          if (!isVisible(element)) {
            continue;
          }

          const text = getText(element);
          if (text) {
            const matched = normalizedTargets.find(
              (target) => text === target || text.includes(target),
            );
            if (matched) {
              const clickable = nearestClickable(element);
              if (clickable && !seen.has(clickable)) {
                seen.add(clickable);
                candidates.push({
                  element: clickable,
                  score: scoreCandidate(clickable),
                });
              }
            }
          }

          if (element.shadowRoot) {
            visitRoot(element.shadowRoot);
          }

          const tagName = element.tagName.toLowerCase();
          if (tagName === "iframe" || tagName === "frame") {
            try {
              const frameDocument = (
                element as HTMLIFrameElement | HTMLFrameElement
              ).contentDocument;
              if (frameDocument) {
                visitRoot(frameDocument);
              }
            } catch {}
          }
        } catch {}
      }
    };

    visitRoot(document);
    candidates.sort((left, right) => right.score - left.score);

    const chosen = candidates[0]?.element;
    if (!chosen) {
      return false;
    }

    chosen.click();
    return true;
  }, options);
}

async function clickButtonByText(
  page: Page,
  texts: string[],
): Promise<boolean> {
  const normalizedTargets = texts
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (normalizedTargets.length === 0) {
    return false;
  }

  const buttonLocator = page.locator("button");
  const count = await buttonLocator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const locator = buttonLocator.nth(index);
    const text = await locator
      .innerText()
      .then((value) => value.replace(/\s+/g, " ").trim())
      .catch(() => "");
    if (!text) {
      continue;
    }

    const matched = normalizedTargets.find(
      (target) => text === target || text.includes(target),
    );
    if (!matched) {
      continue;
    }

    console.log(
      `Clicking button by text. index=${index} text="${text}" matched="${matched}"`,
    );
    await locator.click();
    return true;
  }

  return false;
}

async function hasButtonByText(page: Page, texts: string[]): Promise<boolean> {
  const normalizedTargets = texts
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (normalizedTargets.length === 0) {
    return false;
  }

  const buttonLocator = page.locator("button");
  const count = await buttonLocator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const text = await buttonLocator
      .nth(index)
      .innerText()
      .then((value) => value.replace(/\s+/g, " ").trim())
      .catch(() => "");
    if (!text) {
      continue;
    }

    if (
      normalizedTargets.some(
        (target) => text === target || text.includes(target),
      )
    ) {
      return true;
    }
  }

  return false;
}

async function clickButtonInContentFrameByText(
  page: Page,
  texts: string[],
): Promise<boolean> {
  const normalizedTargets = texts
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (normalizedTargets.length === 0) {
    return false;
  }

  const buttonLocator = page.deepLocator('iframe[name="content"] >> button');
  const count = await buttonLocator.count().catch(() => 0);
  const buttons: Array<{ index: number; text: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const text = await buttonLocator
      .nth(index)
      .innerText()
      .then((value) => value.replace(/\s+/g, " ").trim())
      .catch(() => "");
    if (text) {
      buttons.push({ index, text });
    }
  }

  for (const pass of ["exact", "includes"] as const) {
    for (const button of buttons) {
      const matched = normalizedTargets.find((target) =>
        pass === "exact"
          ? button.text === target
          : button.text.includes(target),
      );
      if (!matched) {
        continue;
      }

      console.log(
        `Clicking content-frame button by text. pass=${pass} index=${button.index} text="${button.text}" matched="${matched}"`,
      );
      try {
        await buttonLocator.nth(button.index).click();
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `Failed clicking content-frame button at index ${button.index}: ${message}`,
        );
      }
    }
  }

  return false;
}

async function clickExactButtonInContentFrame(
  page: Page,
  text: string,
): Promise<boolean> {
  const target = text.replace(/\s+/g, " ").trim();
  if (!target) {
    return false;
  }

  const clicked = await page.evaluate(
    ({ buttonText }) => {
      const frame = document.querySelector(
        'iframe[name="content"]',
      ) as HTMLIFrameElement | null;
      const doc = frame?.contentDocument;
      if (!doc) {
        return false;
      }

      const normalize = (value: string | null | undefined) =>
        (value ?? "").replace(/\s+/g, " ").trim();

      const buttons = Array.from(doc.querySelectorAll("button"));
      const matched = buttons.find((button) => {
        const element = button as HTMLButtonElement;
        const ariaDisabled =
          normalize(element.getAttribute("aria-disabled")).toLowerCase() ===
          "true";
        const classDisabled = normalize(element.getAttribute("class"))
          .toLowerCase()
          .includes("disabled");
        return (
          normalize(element.innerText || element.textContent) === buttonText &&
          !element.disabled &&
          !ariaDisabled &&
          !classDisabled
        );
      }) as HTMLButtonElement | undefined;

      if (!matched) {
        return false;
      }

      matched.click();
      return true;
    },
    { buttonText: target },
  );

  if (clicked) {
    console.log(`Clicked exact content-frame button "${target}".`);
  }
  return clicked;
}

type ContentFrameButtonState = {
  index: number;
  text: string;
  disabled: boolean;
};

async function getContentFrameButtonStates(
  page: Page,
): Promise<ContentFrameButtonState[]> {
  return await page.evaluate(() => {
    const frame = document.querySelector(
      'iframe[name="content"]',
    ) as HTMLIFrameElement | null;
    const doc = frame?.contentDocument;
    if (!doc) {
      return [];
    }

    const normalize = (value: string | null | undefined) =>
      (value ?? "").replace(/\s+/g, " ").trim();

    return Array.from(doc.querySelectorAll("button")).map((button, index) => {
      const element = button as HTMLButtonElement;
      const ariaDisabled =
        normalize(element.getAttribute("aria-disabled")).toLowerCase() ===
        "true";
      const classDisabled = normalize(element.getAttribute("class"))
        .toLowerCase()
        .includes("disabled");

      return {
        index,
        text: normalize(element.innerText || element.textContent),
        disabled: element.disabled || ariaDisabled || classDisabled,
      };
    });
  });
}

async function waitForContentFrameButtonEnabled(
  page: Page,
  text: string,
  timeoutMs: number,
): Promise<boolean> {
  const target = text.replace(/\s+/g, " ").trim();
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const buttons = await getContentFrameButtonStates(page).catch(
      (): ContentFrameButtonState[] => [],
    );
    const matched = buttons.find((button) => button.text === target);
    if (matched && !matched.disabled) {
      console.log(
        `Content-frame button "${target}" is enabled at index ${matched.index}.`,
      );
      return true;
    }

    await page.waitForTimeout(800);
  }

  return false;
}

async function contentFrameTextIncludes(
  page: Page,
  text: string,
): Promise<boolean> {
  return await page
    .deepLocator('iframe[name="content"] >> body')
    .innerText()
    .then((value) => value.includes(text))
    .catch(() => false);
}

async function confirmDraftSaveIfNeeded(page: Page): Promise<void> {
  await page.waitForTimeout(800);
  const buttons = await getContentFrameButtonStates(page).catch(
    (): ContentFrameButtonState[] => [],
  );
  const hasConfirmDialog =
    buttons.some((button) => button.text === "保存" && !button.disabled) &&
    buttons.some((button) => button.text === "不保存" && !button.disabled);
  const clickedConfirm = hasConfirmDialog
    ? await clickButtonInContentFrameByText(page, ["保存"])
    : false;

  if (hasConfirmDialog || clickedConfirm) {
    console.log("Draft save confirmation dialog detected.");
    if (
      clickedConfirm ||
      (await clickButtonInContentFrameByText(page, ["保存"]))
    ) {
      console.log("Confirmed draft save in the content frame.");
      await page.waitForTimeout(1_500);
    }
  }
}

async function hasDomTargetByText(
  page: Page,
  options: TextClickOptions,
): Promise<boolean> {
  return await page.evaluate((input) => {
    const normalizedTargets = input.texts
      .map((text) => text.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (normalizedTargets.length === 0) {
      return false;
    }

    const normalize = (value: string | null | undefined) =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const getView = (element: Element) =>
      element.ownerDocument?.defaultView ?? window;

    const isVisible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) {
        return false;
      }

      const style = getView(element).getComputedStyle(element);
      return !(
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.pointerEvents === "none" ||
        Number(style.opacity || "1") < 0.05
      );
    };

    const getText = (element: Element): string =>
      normalize(
        "innerText" in element
          ? String((element as { innerText?: unknown }).innerText ?? "")
          : element.textContent,
      );

    const visitRoot = (root: Document | ShadowRoot): boolean => {
      const elements = Array.from(root.querySelectorAll("*"));
      for (const element of elements) {
        try {
          if (!isVisible(element)) {
            continue;
          }

          const text = getText(element);
          if (
            text &&
            normalizedTargets.some(
              (target) => text === target || text.includes(target),
            )
          ) {
            return true;
          }

          if (element.shadowRoot && visitRoot(element.shadowRoot)) {
            return true;
          }

          const tagName = element.tagName.toLowerCase();
          if (tagName === "iframe" || tagName === "frame") {
            try {
              const frameDocument = (
                element as HTMLIFrameElement | HTMLFrameElement
              ).contentDocument;
              if (frameDocument && visitRoot(frameDocument)) {
                return true;
              }
            } catch {}
          }
        } catch {}
      }
      return false;
    };

    return visitRoot(document);
  }, options);
}

async function dismissCommonBlockingOverlays(page: Page): Promise<boolean> {
  const dismissTargets: TextClickOptions[] = [
    {
      label: "dismiss overlay",
      texts: ["我知道了", "知道了"],
      preferSmallest: true,
    },
    {
      label: "dismiss overlay",
      texts: ["取消", "关闭", "暂不", "以后再说"],
      preferSmallest: true,
    },
  ];

  let dismissedAny = false;
  for (const target of dismissTargets) {
    for (let index = 0; index < 3; index += 1) {
      const dismissed = await clickTextTarget(page, target).catch(() => false);
      if (!dismissed) {
        break;
      }
      dismissedAny = true;
      console.log(
        `Dismissed blocking overlay using "${target.texts.join("/")}".`,
      );
      await page.waitForTimeout(800);
    }
  }

  return dismissedAny;
}

async function tryDeepClick(
  page: Page,
  selector: string | undefined,
  label: string,
): Promise<boolean> {
  if (!selector) {
    return false;
  }

  try {
    await page.deepLocator(selector).click();
    console.log(`Clicked ${label} via deep locator fallback.`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Deep locator fallback failed for ${label}: ${message}`);
    return false;
  }
}

function shouldPreferDeepClick(selector: string | undefined): boolean {
  if (!selector) {
    return false;
  }

  return (
    selector.startsWith("xpath=") ||
    selector.startsWith("/") ||
    selector.includes("wujie-app") ||
    selector.includes("//html") ||
    selector.includes(">>")
  );
}

async function findAction(
  stagehand: Stagehand,
  page: Page,
  instructions: string[],
  timeout = 6_000,
): Promise<ActionMatch | null> {
  for (const instruction of instructions) {
    try {
      const [action] = await stagehand.observe(instruction, {
        page,
        timeout,
      });
      if (action) {
        return { action, instruction };
      }
    } catch {}
  }
  return null;
}

async function waitForAction(
  stagehand: Stagehand,
  page: Page,
  instructions: string[],
  label: string,
  timeoutMs: number,
): Promise<ActionMatch> {
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    const match = await findAction(stagehand, page, instructions);
    if (match) {
      return match;
    }

    if (attempt % 5 === 0) {
      console.log(`Still waiting for ${label}. currentUrl=${page.url()}`);
    }
    await page.waitForTimeout(1_500);
  }

  throw new Error(`Timed out waiting for ${label}. currentUrl=${page.url()}`);
}

async function observeAndActAny(
  stagehand: Stagehand,
  page: Page,
  instructions: string[],
  label: string,
  timeoutMs = 60_000,
  textFallback?: TextClickOptions,
): Promise<void> {
  const match = await waitForAction(
    stagehand,
    page,
    instructions,
    label,
    timeoutMs,
  );
  console.log(`Using instruction for ${label}: ${match.instruction}`);
  try {
    if (shouldPreferDeepClick(match.action.selector)) {
      const deepClicked = await tryDeepClick(
        page,
        match.action.selector,
        label,
      );
      if (deepClicked) {
        return;
      }
    }

    await stagehand.act(match.action, { page, timeout: 30_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Stagehand act failed for ${label}: ${message}`);

    if (await tryDeepClick(page, match.action.selector, label)) {
      return;
    }

    if (textFallback && (await clickTextTarget(page, textFallback))) {
      return;
    }

    throw error;
  }
}

async function waitForLogin(page: Page): Promise<void> {
  const startedAt = Date.now();
  let attempt = 0;

  console.log(
    "Login is required. Scan the QR code in the opened Chrome window.",
  );
  console.log(
    "The same dedicated Chrome profile will be reused on later runs.",
  );

  while (Date.now() - startedAt < LOGIN_TIMEOUT_MS) {
    attempt += 1;
    const [publishVideoCount, publishButtonFound] = await Promise.all([
      countText(page, "发表视频"),
      hasButtonByText(page, ["发表视频", "发布视频"]).catch(() => false),
    ]);

    if (publishVideoCount > 0 || publishButtonFound) {
      console.log("Login detected. Continuing with the publish flow.");
      return;
    }

    if (attempt % 5 === 0) {
      console.log(
        `Waiting for login to finish. publishVideoCount=${publishVideoCount} publishButtonFound=${publishButtonFound} currentUrl=${page.url()}`,
      );
    }
    await page.waitForTimeout(1_500);
  }

  throw new Error("Timed out waiting for manual login to complete.");
}

async function ensureHomeReady(
  page: Page,
  options?: { cameFromLogin?: boolean },
): Promise<void> {
  const cameFromLogin =
    options?.cameFromLogin ?? page.url().includes("/login.html");
  console.log(
    `ensureHomeReady start. currentUrl=${page.url()} cameFromLogin=${cameFromLogin}`,
  );
  if (cameFromLogin) {
    await waitForLogin(page);
    await page.goto(HOME_URL, {
      waitUntil: "domcontentloaded",
      timeoutMs: 60_000,
    });
    await page.waitForTimeout(3_000);
  }

  const startedAt = Date.now();
  const target: TextClickOptions = {
    label: "home publish button",
    texts: ["发表视频", "发布视频"],
    region: "top",
    preferSmallest: true,
  };
  let attempt = 0;

  while (Date.now() - startedAt < PAGE_READY_TIMEOUT_MS) {
    attempt += 1;
    const dismissedOverlay = await dismissCommonBlockingOverlays(page).catch(
      () => false,
    );
    if (
      page.url().includes("/post/create") ||
      (await isPublishPageLikely(page))
    ) {
      console.log(
        `Publish page already reachable during home wait. dismissedOverlay=${dismissedOverlay} currentUrl=${page.url()}`,
      );
      return;
    }

    const [
      publishVideoCount,
      buttonTextFound,
      textTargetFound,
      domTargetFound,
    ] = await Promise.all([
      countText(page, "发表视频").catch(() => 0),
      hasButtonByText(page, target.texts).catch(() => false),
      hasTextTarget(page, target).catch(() => false),
      hasDomTargetByText(page, target).catch(() => false),
    ]);

    if (
      publishVideoCount > 0 ||
      buttonTextFound ||
      textTargetFound ||
      domTargetFound
    ) {
      console.log(
        `Home page ready. publishVideoCount=${publishVideoCount} buttonTextFound=${buttonTextFound} textTargetFound=${textTargetFound} domTargetFound=${domTargetFound} dismissedOverlay=${dismissedOverlay} currentUrl=${page.url()}`,
      );
      return;
    }

    if (attempt % 5 === 0) {
      console.log(
        `Waiting for home page. publishVideoCount=${publishVideoCount} buttonTextFound=${buttonTextFound} textTargetFound=${textTargetFound} domTargetFound=${domTargetFound} dismissedOverlay=${dismissedOverlay} currentUrl=${page.url()}`,
      );
    }

    if (
      attempt % 10 === 0 &&
      page.url().includes("/platform") &&
      publishVideoCount === 0 &&
      !buttonTextFound &&
      !textTargetFound &&
      !domTargetFound
    ) {
      console.log(
        `Home page is still not interactive after login; refreshing platform home. currentUrl=${page.url()}`,
      );
      await page.goto(HOME_URL, {
        waitUntil: "domcontentloaded",
        timeoutMs: 60_000,
      });
      await page.waitForTimeout(3_000);
    }
    await page.waitForTimeout(1_000);
  }

  throw new Error(
    `Timed out waiting for the home page. currentUrl=${page.url()}`,
  );
}

async function isPublishPageLikely(page: Page): Promise<boolean> {
  const [dynamicCount, uploadCount, fileInputCount] = await Promise.all([
    countText(page, "发表动态"),
    countText(page, "上传视频"),
    page.locator('input[type="file"]').count(),
  ]);

  return dynamicCount > 0 || uploadCount > 0 || fileInputCount > 0;
}

async function waitForPublishPageTransition(
  page: Page,
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isPublishPageLikely(page)) {
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function clickHomePublishButton(
  stagehand: Stagehand,
  page: Page,
): Promise<void> {
  const homeInstructions = [
    "click the 发表视频 button",
    "click the 发布视频 button",
    "click the button that starts publishing a video on the home page",
  ];
  const textFallback: TextClickOptions = {
    label: "home publish button",
    texts: ["发表视频", "发布视频"],
    region: "top",
    preferSmallest: true,
  };

  console.log(
    `Attempting to click the home publish button. currentUrl=${page.url()}`,
  );
  await dismissCommonBlockingOverlays(page).catch(() => false);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const buttonClicked = await clickButtonByText(
      page,
      textFallback.texts,
    ).catch(() => false);
    if (buttonClicked) {
      console.log(
        `Clicked the home publish button via button locator on attempt ${attempt}.`,
      );
      if (await waitForPublishPageTransition(page, 8_000)) {
        console.log(
          "Entered the publish page after clicking the home publish button via button locator.",
        );
        return;
      }
    }

    if (attempt < 5) {
      await dismissCommonBlockingOverlays(page).catch(() => false);
      await page.waitForTimeout(800);
    }
  }

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const domClicked = await clickDomTargetByText(page, textFallback).catch(
      () => false,
    );
    if (domClicked) {
      console.log(`DOM-clicked the home publish button on attempt ${attempt}.`);
      if (await waitForPublishPageTransition(page, 8_000)) {
        console.log(
          "Entered the publish page after DOM-clicking the home publish button.",
        );
        return;
      }
    }

    if (attempt < 8) {
      await dismissCommonBlockingOverlays(page).catch(() => false);
      await page.waitForTimeout(1_000);
    }
  }

  const observedMatch = await findAction(
    stagehand,
    page,
    homeInstructions,
    6_000,
  );
  if (observedMatch) {
    console.log(
      `Trying observed home publish action: ${observedMatch.instruction}`,
    );
    try {
      if (shouldPreferDeepClick(observedMatch.action.selector)) {
        const deepClicked = await tryDeepClick(
          page,
          observedMatch.action.selector,
          "home publish button",
        );
        if (deepClicked && (await waitForPublishPageTransition(page, 8_000))) {
          console.log(
            "Entered the publish page after deep-clicking the observed home publish action.",
          );
          return;
        }
      }

      await stagehand.act(observedMatch.action, { page, timeout: 30_000 });
      if (await waitForPublishPageTransition(page, 8_000)) {
        console.log(
          "Entered the publish page after the observed home publish action.",
        );
        return;
      }
      console.warn(
        `Observed home publish action did not reach the publish page. currentUrl=${page.url()}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Observed home publish action failed: ${message}`);
    }
  }

  const candidates = await findTextClickTargets(page, textFallback);
  for (const [index, candidate] of candidates.slice(0, 3).entries()) {
    console.log(
      `Trying home publish candidate ${index + 1}: "${candidate.text}" (${candidate.tagName}) at (${Math.round(candidate.x)}, ${Math.round(candidate.y)}) score=${candidate.score.toFixed(1)}`,
    );
    await page.click(candidate.x, candidate.y);
    if (await waitForPublishPageTransition(page, 8_000)) {
      console.log(
        "Entered the publish page after clicking the home publish button.",
      );
      return;
    }
  }

  await observeAndActAny(
    stagehand,
    page,
    homeInstructions,
    "home publish button",
    PAGE_READY_TIMEOUT_MS,
    textFallback,
  );

  if (!(await waitForPublishPageTransition(page, 8_000))) {
    throw new Error(
      `Clicked the home publish button but did not reach the publish page. currentUrl=${page.url()}`,
    );
  }
}

async function waitForPublishPage(page: Page): Promise<void> {
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < PAGE_READY_TIMEOUT_MS) {
    attempt += 1;
    const uploadAreaExists = await hasTextTarget(page, {
      label: "upload area",
      texts: ["上传视频", "点击上传", "拖拽视频", "将视频拖拽到此处"],
      region: "left",
      preferLargest: true,
    });

    if ((await isPublishPageLikely(page)) || uploadAreaExists) {
      console.log(`Publish page is ready. currentUrl=${page.url()}`);
      return;
    }

    if (attempt % 5 === 0) {
      console.log(`Waiting for publish page. currentUrl=${page.url()}`);
    }
    await page.waitForTimeout(1_500);
  }

  throw new Error(
    `Timed out waiting for the publish page. currentUrl=${page.url()}`,
  );
}

async function uploadFirstVideo(
  stagehand: Stagehand,
  page: Page,
  filePath: string,
): Promise<void> {
  const existingFileInputCount = await page
    .locator('input[type="file"]')
    .count();
  if (existingFileInputCount === 0) {
    const textFallback: TextClickOptions = {
      label: "upload area",
      texts: ["上传视频", "点击上传", "拖拽视频", "将视频拖拽到此处"],
      region: "left",
      preferLargest: true,
    };

    if (!(await clickTextTarget(page, textFallback))) {
      await observeAndActAny(
        stagehand,
        page,
        [
          "click the upload video area on the left side",
          "click the 上传视频 area on the left side",
          "click the left upload area",
          "click the large upload area for selecting a video file",
        ],
        "upload area",
        60_000,
        textFallback,
      );
    }
  }

  await page.waitForSelector('input[type="file"]', {
    state: "attached",
    timeout: 15_000,
  });
  await page.locator('input[type="file"]').first().setInputFiles(filePath);
  console.log(`Selected video through the upload input: ${filePath}`);
}

async function waitForDescriptionReady(page: Page): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < SAVE_DRAFT_TIMEOUT_MS) {
    const ready = await page
      .deepLocator('iframe[name="content"] >> .input-editor')
      .count()
      .then((count) => count > 0)
      .catch(() => false);
    if (ready) {
      console.log("Video description editor is ready in the content frame.");
      return;
    }
    await page.waitForTimeout(1_000);
  }

  throw new Error(
    `Timed out waiting for the video description editor. currentUrl=${page.url()}`,
  );
}

function resolveDescriptionTopic(): string {
  return process.env.WECHAT_VIDEO_TOPIC?.trim() || DEFAULT_TOPIC;
}

function sanitizeForInstruction(text: string): string {
  return text.replace(/["']/g, "").replace(/\s+/g, " ").trim();
}

async function generateDescriptionWithStagehand(
  stagehand: Stagehand,
  page: Page,
  topic: string,
): Promise<string> {
  const result = await stagehand.extract(
    [
      `Generate one natural Chinese video description related to ${sanitizeForInstruction(topic)}.`,
      "Return only the generated description.",
      "Requirements: 40 to 80 Chinese characters, conversational, vivid, positive.",
      "Do not add quotes, hashtags, @mentions, or line breaks.",
    ].join(" "),
    z.object({
      description: z.string(),
    }),
    { page, timeout: 30_000 },
  );

  const description = sanitizeForInstruction(result.description);
  if (!description) {
    throw new Error("Stagehand did not generate a usable video description.");
  }

  console.log(`Generated description with Stagehand: ${description}`);
  return description;
}

async function fillDescription(
  stagehand: Stagehand,
  page: Page,
  topic: string,
): Promise<void> {
  const description = await generateDescriptionWithStagehand(
    stagehand,
    page,
    topic,
  );
  const editor = page.deepLocator('iframe[name="content"] >> .input-editor');
  await editor.click();
  await editor.type(description);
  console.log(
    "Filled the video description with a Stagehand-generated caption.",
  );
}

async function saveDraft(page: Page): Promise<void> {
  console.log("Waiting 5 seconds before clicking save draft.");
  await page.waitForTimeout(5_000);

  const clicked = await clickButtonInContentFrameByText(page, ["保存草稿"]);

  if (!clicked) {
    const buttonStates = await getContentFrameButtonStates(page).catch(
      (): ContentFrameButtonState[] => [],
    );
    throw new Error(
      `Could not click the save draft button in the content frame. Buttons: ${JSON.stringify(buttonStates)}`,
    );
  }

  console.log("Clicked save draft in the content frame.");
  await confirmDraftSaveIfNeeded(page);
}

async function example(stagehand: Stagehand): Promise<void> {
  const page = stagehand.context.pages()[0];
  const uploadDirectory = resolveUploadDirectory();
  const filePath = pickFirstUploadFile(uploadDirectory);
  const topic = resolveDescriptionTopic();

  console.log(`Upload directory: ${uploadDirectory}`);
  console.log(`Selected file: ${filePath}`);
  console.log(`Description topic: ${topic}`);

  await page.goto(HOME_URL, {
    waitUntil: "domcontentloaded",
    timeoutMs: 60_000,
  });
  const landedOnLogin = page.url().includes("/login.html");
  console.log(
    `Initial landing after goto. currentUrl=${page.url()} landedOnLogin=${landedOnLogin}`,
  );
  await ensureHomeReady(page, { cameFromLogin: landedOnLogin });
  await clickHomePublishButton(stagehand, page);
  await waitForPublishPage(page);
  await uploadFirstVideo(stagehand, page, filePath);
  await waitForDescriptionReady(page);
  await fillDescription(stagehand, page, topic);
  await saveDraft(page);
  console.log("The draft save action has been submitted.");
}

(async () => {
  const viewport = resolvePreferredViewport();
  const userDataDir =
    process.env.WECHAT_VIDEO_PROFILE_DIR ??
    path.resolve(process.cwd(), ".profiles", "wechat-video-channels");
  const profileDirectory =
    process.env.WECHAT_VIDEO_PROFILE_DIRECTORY ?? "Default";
  const autoClose =
    process.env.WECHAT_VIDEO_AUTO_CLOSE === "1" ||
    process.env.WECHAT_VIDEO_AUTO_CLOSE === "true";

  fs.mkdirSync(path.join(userDataDir, profileDirectory), { recursive: true });

  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: {
      userDataDir,
      preserveUserDataDir: true,
      headless: false,
      acceptDownloads: true,
      connectTimeoutMs: 30_000,
      // viewport,
      args: [`--profile-directory=${profileDirectory}`],
    },
    cacheDir: "wechat-video-act-cache",
    model: resolveStagehandModel(),
    verbose: 2,
  });

  try {
    console.log(`Using viewport: ${viewport.width}x${viewport.height}`);
    console.log(`Using userDataDir: ${userDataDir}`);
    console.log(`Using profile directory: ${profileDirectory}`);
    await stagehand.init();
    await example(stagehand);
    if (!autoClose) {
      console.log(
        "Automation finished. The browser is still open for inspection. Set WECHAT_VIDEO_AUTO_CLOSE=1 to close it automatically.",
      );
    }
  } catch (error) {
    if (!autoClose) {
      console.error(
        "Automation failed. The browser is still open for debugging. Set WECHAT_VIDEO_AUTO_CLOSE=1 to close it automatically.",
      );
    }
    throw error;
  } finally {
    if (autoClose) {
      await stagehand.close();
    }
  }
})();
