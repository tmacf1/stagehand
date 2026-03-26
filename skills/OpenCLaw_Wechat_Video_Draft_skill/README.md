# OpenClaw WeChat Channels Video Draft Skill

这个技能包可以让 OpenClaw 在收到“微信视频号发视频 / 上传视频 / 保存草稿”相关请求时，进入配置好的 Stagehand 目录并执行：

```bash
pnpm example wechat_video_draft
```

## 目录结构

```text
OpenCLaw_Wechat_Video_Draft_skill/
├── README.md
├── SKILL.md
└── scripts/
    └── run_wechat_video_draft.sh
```

## 安装方式

将整个目录复制到你的 OpenClaw 本地技能目录，例如：

```bash
your_dir/clawd/skills/local/wechat-video-draft/
```

如果 OpenClaw 已经在运行，复制完成后可以执行：

```bash
openclaw gateway restart
```

## 配置

脚本默认使用下面这个 Stagehand 项目目录：

```bash
/Users/taozi/gocode/stagehand
```

如果你的 Stagehand 不在这个位置，可以：

1. 直接修改 `scripts/run_wechat_video_draft.sh` 里的默认值
2. 或运行时传入 `--stagehand-dir`
3. 或设置环境变量 `STAGEHAND_PROJECT_DIR`

## 用法

最简单的调用：

```bash
skills/local/wechat-video-draft/scripts/run_wechat_video_draft.sh
```

带参数调用：

```bash
skills/local/wechat-video-draft/scripts/run_wechat_video_draft.sh \
  --stagehand-dir "/Users/taozi/gocode/stagehand" \
  --upload-dir "/Users/taozi/Downloads/dytest" \
  --topic "鹦鹉聪明" \
  --auto-close
```

也可以用环境变量：

```bash
STAGEHAND_PROJECT_DIR="/Users/taozi/gocode/stagehand" \
WECHAT_VIDEO_UPLOAD_DIR="/Users/taozi/Downloads/dytest" \
WECHAT_VIDEO_TOPIC="鹦鹉聪明" \
WECHAT_VIDEO_AUTO_CLOSE=1 \
skills/local/wechat-video-draft/scripts/run_wechat_video_draft.sh
```

## 可用参数

- `--stagehand-dir DIR`: 指定 Stagehand 项目目录
- `--upload-dir DIR`: 指定视频目录，会导出为 `WECHAT_VIDEO_UPLOAD_DIR`
- `--topic TEXT`: 指定描述主题，会导出为 `WECHAT_VIDEO_TOPIC`
- `--model MODEL`: 指定 `STAGEHAND_MODEL_NAME`
- `--profile-dir DIR`: 指定 `WECHAT_VIDEO_PROFILE_DIR`
- `--profile NAME`: 指定 `WECHAT_VIDEO_PROFILE_DIRECTORY`
- `--auto-close`: 运行完成后自动关闭浏览器
- `--dry-run`: 只打印命令，不实际执行
- `-h`, `--help`: 查看帮助

## 注意事项

- 这个 Stagehand 示例当前做的是“上传视频并保存草稿”，不是最后一步正式点击“发表”。
- `pnpm example wechat_video_draft` 会读取 Stagehand 项目中的 `.env`。
- 示例默认会从 `WECHAT_VIDEO_UPLOAD_DIR` 指向的目录中挑选一个文件上传；如果不传，则走 Stagehand 示例自己的默认目录逻辑。
