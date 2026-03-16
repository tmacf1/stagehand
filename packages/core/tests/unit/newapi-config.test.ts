import { afterEach, describe, expect, it } from "vitest";
import { V3 } from "../../lib/v3/v3.js";

const ENV_KEYS = [
  "NEWAPI_API_KEY",
  "NEWAPI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

describe("newapi configuration", () => {
  const originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>;

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("autoloads NEWAPI_API_KEY and NEWAPI_BASE_URL for newapi provider models", () => {
    process.env.NEWAPI_API_KEY = "newapi-test-key";
    process.env.NEWAPI_BASE_URL = "https://newapi.example.com/v1";

    const stagehand = new V3({
      env: "LOCAL",
      model: "newapi/gpt-4.1-mini",
    });

    expect(
      (
        stagehand as unknown as {
          modelClientOptions: Record<string, string>;
        }
      ).modelClientOptions,
    ).toMatchObject({
      apiKey: "newapi-test-key",
      baseURL: "https://newapi.example.com/v1",
    });
  });
});
