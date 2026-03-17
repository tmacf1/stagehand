---
name: wechat-video-draft
description: Uploads a video to WeChat Channels (微信视频号/视频号) and saves it as a draft by entering the configured Stagehand directory and running `pnpm example wechat_video_draft`. Use when the user asks to publish, upload, post, save a draft, or send a video to WeChat Channels.
---

# WeChat Video Draft Skill

Use this skill when the user asks for WeChat Channels tasks such as:

- "帮我发一个微信视频号视频"
- "把这个视频上传到视频号"
- "帮我保存视频号草稿"
- "发布一个视频号内容"

## Execution Rules

1. Prefer running `scripts/run_wechat_video_draft.sh`.
2. If the user provides a specific upload directory, pass `--upload-dir` or set `WECHAT_VIDEO_UPLOAD_DIR`.
3. If the user provides a specific topic, pass `--topic` or set `WECHAT_VIDEO_TOPIC`.
4. Do not manually re-implement the browser steps unless the script or the Stagehand example fails.
5. Tell the user that this flow currently uploads the video and clicks `保存草稿`; it does not guarantee a final publish click.

## Command

```bash
skills/local/wechat-video-draft/scripts/run_wechat_video_draft.sh
```

## Examples

```bash
skills/local/wechat-video-draft/scripts/run_wechat_video_draft.sh
```

```bash
skills/local/wechat-video-draft/scripts/run_wechat_video_draft.sh --upload-dir "/Users/taozi/Downloads/dytest" --topic "鹦鹉聪明"
```
