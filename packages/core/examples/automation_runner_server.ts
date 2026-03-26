import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { URL } from "node:url";

const HOST = process.env.AUTOMATION_RUNNER_SERVER_HOST ?? "0.0.0.0";
const PORT = Number.parseInt(
  process.env.AUTOMATION_RUNNER_SERVER_PORT ?? "8788",
  10,
);
const MAX_LOG_LINES = 400;
const WORKSPACE_ROOT = path.resolve(process.cwd(), "..", "..");
const PACKAGES_DIR = path.join(WORKSPACE_ROOT, "packages");
const JOBS_RUNTIME_DIR = path.join(WORKSPACE_ROOT, ".runtime", "automation_jobs");

type JobStatus = "running" | "completed" | "failed";

type AutomationParamValue =
  | string
  | number
  | boolean
  | null
  | AutomationParamValue[]
  | Record<string, unknown>;

type AutomationRunRequest = {
  moduleName?: string;
  fileName: string;
  params?: Record<string, AutomationParamValue>;
};

type AutomationJobInputRequest = {
  params?: Record<string, AutomationParamValue>;
};

type ModuleTarget = {
  alias: string;
  packageName: string;
  packageDir: string;
};

type JobRecord = {
  id: string;
  status: JobStatus;
  command: string[];
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  logs: string[];
  child: ChildProcess;
  moduleName: string;
  fileName: string;
  inputFilePath: string;
};

const jobs = new Map<string, JobRecord>();

function json(
  reply: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload, null, 2);
  reply.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  reply.end(body);
}

function appendJobLog(job: JobRecord, chunk: string): void {
  const lines = chunk
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  if (lines.length === 0) {
    return;
  }

  job.logs.push(...lines);
  if (job.logs.length > MAX_LOG_LINES) {
    job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
  }
}

async function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) {
    throw new Error("Request body is required.");
  }

  return JSON.parse(body) as T;
}

function ensureJobsRuntimeDir(): void {
  fs.mkdirSync(JOBS_RUNTIME_DIR, { recursive: true });
}

function getJobRuntimeDir(jobId: string): string {
  return path.join(JOBS_RUNTIME_DIR, jobId);
}

function getJobInputFilePath(jobId: string): string {
  return path.join(getJobRuntimeDir(jobId), "input.json");
}

function readInputParams(filePath: string): Record<string, AutomationParamValue> {
  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    if (!content) {
      return {};
    }

    const parsed = JSON.parse(content) as Record<string, AutomationParamValue>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function writeInputParams(
  filePath: string,
  params: Record<string, AutomationParamValue>,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(params, null, 2), "utf8");
}

function listWorkspaceModules(): ModuleTarget[] {
  const entries = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true });
  const targets: ModuleTarget[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageJsonPath = path.join(PACKAGES_DIR, entry.name, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
    };
    if (!packageJson.name) {
      continue;
    }

    targets.push({
      alias: entry.name,
      packageName: packageJson.name,
      packageDir: path.join(PACKAGES_DIR, entry.name),
    });
  }

  return targets;
}

function resolveModuleTarget(moduleName: string): ModuleTarget | null {
  const normalized = moduleName.trim();
  if (!normalized) {
    return null;
  }

  const targets = listWorkspaceModules();
  return (
    targets.find((target) => target.packageName === normalized) ??
    targets.find((target) => target.alias === normalized) ??
    null
  );
}

function resolveRequestedModuleName(moduleName: string | undefined): string {
  const normalized = moduleName?.trim();
  return normalized || "core";
}

function isSafeFileName(value: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..");
}

function isSafeParamKey(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function flattenParams(
  params: Record<string, AutomationParamValue> | undefined,
): string[] {
  if (!params) {
    return [];
  }

  const cliArgs: string[] = [];

  for (const [rawKey, rawValue] of Object.entries(params)) {
    if (!isSafeParamKey(rawKey)) {
      throw new Error(`Invalid param key: ${rawKey}`);
    }

    if (rawValue === undefined || rawValue === null) {
      continue;
    }

    const flag = rawKey.startsWith("--") ? rawKey : `--${rawKey}`;

    if (Array.isArray(rawValue)) {
      for (const item of rawValue) {
        if (item === undefined || item === null) {
          continue;
        }
        cliArgs.push(flag, typeof item === "string" ? item : JSON.stringify(item));
      }
      continue;
    }

    if (typeof rawValue === "object") {
      cliArgs.push(flag, JSON.stringify(rawValue));
      continue;
    }

    cliArgs.push(flag, String(rawValue));
  }

  return cliArgs;
}

function validateRunRequest(payload: AutomationRunRequest): string | null {
  if (!payload.fileName?.trim()) {
    return "fileName is required.";
  }

  if (!isSafeFileName(payload.fileName.trim())) {
    return "fileName contains unsafe characters.";
  }

  const target = resolveModuleTarget(resolveRequestedModuleName(payload.moduleName));
  if (!target) {
    return `Unknown moduleName: ${resolveRequestedModuleName(payload.moduleName)}`;
  }

  return null;
}

function buildRunCommand(payload: AutomationRunRequest): string[] {
  const target = resolveModuleTarget(resolveRequestedModuleName(payload.moduleName));
  if (!target) {
    throw new Error(
      `Unknown moduleName: ${resolveRequestedModuleName(payload.moduleName)}`,
    );
  }

  return ["run", "example", "--", payload.fileName.trim(), ...flattenParams(payload.params)];
}

function createJob(payload: AutomationRunRequest): JobRecord {
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const target = resolveModuleTarget(resolveRequestedModuleName(payload.moduleName));
  if (!target) {
    throw new Error(
      `Unknown moduleName: ${resolveRequestedModuleName(payload.moduleName)}`,
    );
  }
  ensureJobsRuntimeDir();
  const inputFilePath = getJobInputFilePath(id);
  writeInputParams(inputFilePath, {});
  const command = buildRunCommand(payload);
  const childEnv = {
    ...process.env,
    AUTOMATION_JOB_ID: id,
    AUTOMATION_JOB_INPUT_JSON: inputFilePath,
  };
  const child = spawn("pnpm", command, {
    cwd: target.packageDir,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const job: JobRecord = {
    id,
    status: "running",
    command: ["pnpm", ...command],
    createdAt: startedAt,
    startedAt,
    finishedAt: null,
    exitCode: null,
    logs: [],
    child,
    moduleName: resolveRequestedModuleName(payload.moduleName),
    fileName: payload.fileName.trim(),
    inputFilePath,
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => appendJobLog(job, chunk));
  child.stderr?.on("data", (chunk: string) => appendJobLog(job, chunk));

  child.on("exit", (code) => {
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    job.status = code === 0 ? "completed" : "failed";
  });

  child.on("error", (error) => {
    appendJobLog(job, `Spawn error: ${error.message}`);
    job.exitCode = -1;
    job.finishedAt = new Date().toISOString();
    job.status = "failed";
  });

  jobs.set(id, job);
  return job;
}

function serializeJob(job: JobRecord) {
  return {
    id: job.id,
    status: job.status,
    moduleName: job.moduleName,
    fileName: job.fileName,
    inputFilePath: job.inputFilePath,
    command: job.command.join(" "),
    pid: job.child.pid ?? null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    logs: job.logs,
  };
}

function extractJobId(url: URL): string | null {
  const match = url.pathname.match(/^\/api\/automation\/jobs\/([^/]+)$/);
  return match?.[1] ?? null;
}

function extractJobInputId(url: URL): string | null {
  const match = url.pathname.match(/^\/api\/automation\/jobs\/([^/]+)\/input$/);
  return match?.[1] ?? null;
}

const server = http.createServer(async (request, reply) => {
  try {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (method === "GET" && url.pathname === "/health") {
      json(reply, 200, {
        ok: true,
        service: "automation-runner-server",
        now: new Date().toISOString(),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/automation/modules") {
      json(reply, 200, {
        modules: listWorkspaceModules().map((target) => ({
          alias: target.alias,
          packageName: target.packageName,
          packageDir: target.packageDir,
        })),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/automation/jobs") {
      json(reply, 200, {
        jobs: Array.from(jobs.values())
          .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
          .map(serializeJob),
      });
      return;
    }

    const inputJobId = extractJobInputId(url);
    if (method === "POST" && inputJobId) {
      const job = jobs.get(inputJobId);
      if (!job) {
        json(reply, 404, { error: "Job not found." });
        return;
      }

      const payload = await readJsonBody<AutomationJobInputRequest>(request);
      const params = payload.params;
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        json(reply, 400, { error: "params object is required." });
        return;
      }

      const currentParams = readInputParams(job.inputFilePath);
      const nextParams = {
        ...currentParams,
        ...params,
      };
      writeInputParams(job.inputFilePath, nextParams);

      json(reply, 200, {
        message: "Job input accepted.",
        jobId: job.id,
        inputFilePath: job.inputFilePath,
        params: nextParams,
      });
      return;
    }

    const jobId = extractJobId(url);
    if (method === "GET" && jobId) {
      const job = jobs.get(jobId);
      if (!job) {
        json(reply, 404, { error: "Job not found." });
        return;
      }

      json(reply, 200, serializeJob(job));
      return;
    }

    if (method === "POST" && url.pathname === "/api/automation/run") {
      const payload = await readJsonBody<AutomationRunRequest>(request);
      const validationError = validateRunRequest(payload);
      if (validationError) {
        json(reply, 400, { error: validationError });
        return;
      }

      const job = createJob(payload);
      json(reply, 200, {
        message: "Automation job started.",
        job: serializeJob(job),
        statusUrl: `/api/automation/jobs/${job.id}`,
      });
      return;
    }

    json(reply, 404, { error: "Not found." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(reply, 500, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  const examplePayload = {
    fileName: "exchange_update_avatar",
    params: {
      account: "superadmin",
      avatar: "/Users/taozi/Downloads/1.png",
    },
  };

  console.log(`Automation runner HTTP server listening on http://${HOST}:${PORT}`);
  console.log(`Health: GET /health`);
  console.log(`Jobs: GET /api/automation/jobs`);
  console.log(`Start job: POST /api/automation/run`);
  console.log(`Example payload: ${JSON.stringify(examplePayload)}`);
});
