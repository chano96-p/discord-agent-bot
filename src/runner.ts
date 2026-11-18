import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadChannel } from "discord.js";
import { config } from "./config.js";
import { makeCanUseTool } from "./permissions.js";
import type { Workspace } from "./workspace.js";

export type RunResult = { ok: boolean; text: string; sessionId?: string; costUsd?: number };

const JOB_HINT =
  "You are running as a Discord-driven agent. Save any files you produce under ./outputs/ so they can be attached to the reply. Reply in Korean.";
const WORKTREE_HINT =
  "You are running as a Discord-driven agent inside a git worktree. Make the requested change, but do not commit, push, or create PRs. Finish with a short Korean summary of what changed.";

export async function runClaude(opts: {
  prompt: string;
  workspace: Workspace;
  resume?: string;
  thread: ThreadChannel;
  abort: AbortController;
}): Promise<RunResult> {
  const { prompt, workspace, resume, thread, abort } = opts;
  const status = await thread.send("⏳ 작업 시작");
  const timer = setTimeout(() => abort.abort(), config.jobTimeoutMs);

  let lastEdit = 0;
  const updateStatus = (line: string) => {
    if (Date.now() - lastEdit < 3000) return; // 디스코드 rate limit 보호
    lastEdit = Date.now();
    status.edit(`⏳ ${line}`).catch(() => {});
  };

  const result: RunResult = { ok: false, text: "" };

  try {
    const q = query({
      prompt,
      options: {
        cwd: workspace.cwd,
        resume,
        model: config.model,
        // 작업 공간 안의 파일 편집은 자동 허용, 그 외(Bash, 외부 경로 등)는 버튼으로 승인
        permissionMode: "acceptEdits",
        canUseTool: makeCanUseTool(thread),
        abortController: abort,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: workspace.kind === "job" ? JOB_HINT : WORKTREE_HINT,
        },
      },
    });

    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") {
        result.sessionId = m.session_id;
      } else if (m.type === "assistant") {
        for (const block of m.message.content) {
          if (block.type === "tool_use") updateStatus(`${block.name} 사용 중`);
        }
      } else if (m.type === "result") {
        result.sessionId = m.session_id;
        result.costUsd = m.total_cost_usd;
        result.ok = m.subtype === "success";
        result.text = m.subtype === "success" ? m.result : `작업이 정상 종료되지 않았습니다 (${m.subtype})`;
      }
    }
  } catch (err) {
    result.text = abort.signal.aborted
      ? "작업이 중단되었습니다 (타임아웃 또는 !stop)"
      : `오류: ${(err as Error).message}`;
  } finally {
    clearTimeout(timer);
    await status.edit(result.ok ? "✅ 완료" : "⚠️ 종료").catch(() => {});
  }

  return result;
}
