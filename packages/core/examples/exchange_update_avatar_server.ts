import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as http from "node:http";
import { URL } from "node:url";

const HOST = process.env.EXCHANGE_AVATAR_SERVER_HOST ?? "0.0.0.0";
const PORT = Number.parseInt(
  process.env.EXCHANGE_AVATAR_SERVER_PORT ?? "8787",
  10,
);
const MAX_LOG_LINES = 400;

type RunRequest = {
  account: string;
  avatarPath: string;
  xlsxPath?: string;
  codeFilePath?: string;
  cacheDir?: string;
  persistentProfile?: boolean;
  headless?: boolean;
  closeOnError?: boolean;
};

type JobStatus = "running" | "completed" | "failed";

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

function normalizeBooleanArg(value: boolean | undefined): string | null {
  if (typeof value !== "boolean") {
    return null;
  }
  return value ? "true" : "false";
}

function validateRunRequest(payload: RunRequest): string | null {
  if (!payload.account?.trim()) {
    return "account is required.";
  }

  if (!payload.avatarPath?.trim()) {
    return "avatarPath is required.";
  }

  return null;
}

function buildRunCommand(payload: RunRequest): string[] {
  const command = [
    "run",
    "example",
    "--",
    "exchange_update_avatar",
    "--account",
    payload.account.trim(),
    "--avatar",
    payload.avatarPath.trim(),
  ];

  if (payload.xlsxPath?.trim()) {
    command.push("--xlsx", payload.xlsxPath.trim());
  }

  if (payload.codeFilePath?.trim()) {
    command.push("--code-file", payload.codeFilePath.trim());
  }

  if (payload.cacheDir?.trim()) {
    command.push("--cache-dir", payload.cacheDir.trim());
  }

  const persistentProfile = normalizeBooleanArg(payload.persistentProfile);
  if (persistentProfile) {
    command.push("--persistent-profile", persistentProfile);
  }

  const headless = normalizeBooleanArg(payload.headless);
  if (headless) {
    command.push("--headless", headless);
  }

  const closeOnError = normalizeBooleanArg(payload.closeOnError);
  if (closeOnError) {
    command.push("--close-on-error", closeOnError);
  }

  return command;
}

function createJob(payload: RunRequest): JobRecord {
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const packageCoreDir = process.cwd();
  const command = buildRunCommand(payload);
  const child = spawn("pnpm", command, {
    cwd: packageCoreDir,
    env: process.env,
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
  const match = url.pathname.match(/^\/api\/exchange\/avatar-run\/([^/]+)$/);
  return match?.[1] ?? null;
}

const server = http.createServer(async (request, reply) => {
  try {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (method === "GET" && url.pathname === "/health") {
      json(reply, 200, {
        ok: true,
        service: "exchange-update-avatar-server",
        now: new Date().toISOString(),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/exchange/avatar-run") {
      json(reply, 200, {
        jobs: Array.from(jobs.values())
          .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
          .map(serializeJob),
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

    if (method === "POST" && url.pathname === "/api/exchange/avatar-run") {
      const payload = await readJsonBody<RunRequest>(request);
      const validationError = validateRunRequest(payload);
      if (validationError) {
        json(reply, 400, { error: validationError });
        return;
      }

      const job = createJob(payload);
      json(reply, 202, {
        message: "Avatar update job started.",
        job: serializeJob(job),
        statusUrl: `/api/exchange/avatar-run/${job.id}`,
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
    account: "superadmin",
    avatarPath: "/Users/taozi/Downloads/1.png",
  };

  console.log(
    `Exchange avatar HTTP server listening on http://${HOST}:${PORT}`,
  );
  console.log(`Health: GET /health`);
  console.log(`Start job: POST /api/exchange/avatar-run`);
  console.log(`Example payload: ${JSON.stringify(examplePayload)}`);
});
