# Automation Runner API

适用于仓库中的通用自动化执行服务：
[automation_runner_server.ts](/Users/taozi/gocode/stagehand/packages/core/examples/automation_runner_server.ts)

默认监听地址：

```text
http://127.0.0.1:8788
```

启动方式：

```bash
cd /Users/taozi/gocode/stagehand
./start_auto_server.sh start
```

## Overview

该服务用于通过 HTTP 接口启动并管理 `packages/*/examples/*.ts` 下的自动化脚本。

特点：

- `POST JSON` 触发任务
- `params` 自动转为命令行参数
- 支持查看任务状态和日志
- 支持运行中二次传参
- `moduleName` 可省略，默认 `core`

## Base URL

```text
http://127.0.0.1:8788
```

## Response Conventions

成功响应通常返回：

- `200` 成功

失败响应通常返回：

- `400` 参数错误
- `404` 资源不存在
- `500` 服务内部错误

## Job Status

任务状态字段 `status` 可能取值：

- `running`
- `completed`
- `failed`

## Endpoints

### 1. Health Check

**Method**

```http
GET /health
```

**Description**

检查服务是否正常运行。

**Example**

```bash
curl http://127.0.0.1:8788/health
```

**Response Example**

```json
{
  "ok": true,
  "service": "automation-runner-server",
  "now": "2026-03-26T01:00:00.000Z"
}
```

### 2. List Available Modules

**Method**

```http
GET /api/automation/modules
```

**Description**

列出当前 workspace 中可用的模块。`moduleName` 可以传模块别名，也可以传完整包名。

**Example**

```bash
curl http://127.0.0.1:8788/api/automation/modules
```

**Response Example**

```json
{
  "modules": [
    {
      "alias": "core",
      "packageName": "@browserbasehq/stagehand",
      "packageDir": "/Users/taozi/gocode/stagehand/packages/core"
    },
    {
      "alias": "server-v4",
      "packageName": "@browserbasehq/stagehand-server-v4",
      "packageDir": "/Users/taozi/gocode/stagehand/packages/server-v4"
    }
  ]
}
```

### 3. Start Automation Job

**Method**

```http
POST /api/automation/run
```

**Description**

启动一个自动化任务。

服务内部执行逻辑：

```bash
cd <moduleDir>
pnpm run example -- <fileName> <params...>
```

**Request Body**

```json
{
  "moduleName": "core",
  "fileName": "exchange_update_avatar",
  "params": {
    "account": "superadmin",
    "avatar": "/Users/taozi/Downloads/1.png"
  }
}
```

**Fields**

- `moduleName`: 可选。模块名，默认 `core`
- `fileName`: 必填。脚本名，不带 `.ts`
- `params`: 可选。键值对参数，会自动转成 `--key value`

**Parameter Conversion Rules**

传入：

```json
{
  "params": {
    "account": "superadmin",
    "headless": false,
    "tags": ["a", "b"],
    "meta": { "x": 1 }
  }
}
```

会转换为类似：

```bash
--account superadmin --headless false --tags a --tags b --meta '{"x":1}'
```

**Example**

```bash
curl -X POST http://127.0.0.1:8788/api/automation/run \
  -H 'Content-Type: application/json' \
  -d '{
    "fileName": "exchange_update_avatar",
    "params": {
      "account": "superadmin",
      "avatar": "/Users/taozi/Downloads/1.png"
    }
  }'
```

**Response Example**

```json
{
  "message": "Automation job started.",
  "job": {
    "id": "job-id",
    "status": "running",
    "moduleName": "core",
    "fileName": "exchange_update_avatar",
    "inputFilePath": "/Users/taozi/gocode/stagehand/.runtime/automation_jobs/job-id/input.json",
    "command": "pnpm run example -- exchange_update_avatar --account superadmin --avatar /Users/taozi/Downloads/1.png",
    "pid": 12345,
    "createdAt": "2026-03-26T01:00:00.000Z",
    "startedAt": "2026-03-26T01:00:00.000Z",
    "finishedAt": null,
    "exitCode": null,
    "logs": []
  },
  "statusUrl": "/api/automation/jobs/job-id"
}
```

### 4. List All Jobs

**Method**

```http
GET /api/automation/jobs
```

**Description**

列出当前进程内记录的所有任务。

**Example**

```bash
curl http://127.0.0.1:8788/api/automation/jobs
```

**Response Example**

```json
{
  "jobs": [
    {
      "id": "job-id",
      "status": "running",
      "moduleName": "core",
      "fileName": "exchange_update_avatar",
      "inputFilePath": "/Users/taozi/gocode/stagehand/.runtime/automation_jobs/job-id/input.json",
      "command": "pnpm run example -- exchange_update_avatar --account superadmin --avatar /Users/taozi/Downloads/1.png",
      "pid": 12345,
      "createdAt": "2026-03-26T01:00:00.000Z",
      "startedAt": "2026-03-26T01:00:00.000Z",
      "finishedAt": null,
      "exitCode": null,
      "logs": [
        "Using a temporary browser session."
      ]
    }
  ]
}
```

### 5. Query Job Detail

**Method**

```http
GET /api/automation/jobs/:jobId
```

**Description**

查询指定任务详情，包括状态、日志和执行命令。

**Example**

```bash
curl http://127.0.0.1:8788/api/automation/jobs/job-id
```

**Response Example**

```json
{
  "id": "job-id",
  "status": "completed",
  "moduleName": "core",
  "fileName": "exchange_update_avatar",
  "inputFilePath": "/Users/taozi/gocode/stagehand/.runtime/automation_jobs/job-id/input.json",
  "command": "pnpm run example -- exchange_update_avatar --account superadmin --avatar /Users/taozi/Downloads/1.png",
  "pid": 12345,
  "createdAt": "2026-03-26T01:00:00.000Z",
  "startedAt": "2026-03-26T01:00:00.000Z",
  "finishedAt": "2026-03-26T01:03:00.000Z",
  "exitCode": 0,
  "logs": [
    "Avatar updated successfully. Closing browser."
  ]
}
```

### 6. Send Input to a Running Job

**Method**

```http
POST /api/automation/job/input
```

**Description**

向运行中的任务补传参数。服务会把参数写入该 job 的输入文件，脚本侧自行读取。

当前 `exchange_update_avatar` 已支持通过此接口后补验证码。

**Request Body**

```json
{
  "jobId": "job-id",
  "params": {
    "code": "123456"
  }
}
```

**Supported Use Case**

例如：

1. 先启动头像自动化任务
2. 脚本输入用户名/密码后开始等待验证码
3. 再通过此接口传入验证码

**Example**

```bash
curl -X POST http://127.0.0.1:8788/api/automation/job/input \
  -H 'Content-Type: application/json' \
  -d '{
    "jobId": "job-id",
    "params": {
      "code": "123456"
    }
  }'
```

**Response Example**

```json
{
  "message": "Job input accepted.",
  "jobId": "job-id",
  "inputFilePath": "/Users/taozi/gocode/stagehand/.runtime/automation_jobs/<jobId>/input.json",
  "params": {
    "code": "123456"
  }
}
```

## Recommended Flow

以 `exchange_update_avatar` 为例：

### Step 1. Start Job

```bash
curl -X POST http://127.0.0.1:8788/api/automation/run \
  -H 'Content-Type: application/json' \
  -d '{
    "fileName": "exchange_update_avatar",
    "params": {
      "account": "superadmin",
      "avatar": "/Users/taozi/Downloads/1.png"
    }
  }'
```

### Step 2. Query Job Status

```bash
curl http://127.0.0.1:8788/api/automation/jobs/<jobId>
```

### Step 3. Send OTP Later

```bash
curl -X POST http://127.0.0.1:8788/api/automation/job/input \
  -H 'Content-Type: application/json' \
  -d '{
    "jobId": "<jobId>",
    "params": {
      "code": "123456"
    }
  }'
```

## Error Examples

### Missing fileName

```json
{
  "error": "fileName is required."
}
```

### Unknown moduleName

```json
{
  "error": "Unknown moduleName: xxx"
}
```

### Unknown job

```json
{
  "error": "Job not found."
}
```

## Notes

- 当前任务记录保存在服务进程内存中，服务重启后历史 job 列表不会保留。
- `inputFilePath` 是服务内部实现细节，正常情况下只需要通过 HTTP 接口传参，不需要手动写文件。
- 如果修改了接口实现，记得重启服务：

```bash
cd /Users/taozi/gocode/stagehand
./start_auto_server.sh restart
```
