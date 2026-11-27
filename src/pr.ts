import { existsSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadChannel } from "discord.js";
import { config } from "./config.js";
import { commitAll, commitCount, createDraftPr, ghToken, git, hasUncommitted, pushBranch } from "./git.js";
import { askApproval } from "./permissions.js";
import { sessions, type ThreadState } from "./sessions.js";
import { removeWorktree, type Workspace } from "./workspace.js";

type Worktree = Extract<Workspace, { kind: "worktree" }>;
type Description = { commitMessage: string; prTitle: string; prBody: string };

const DIFF_LIMIT = 20_000;

const DESCRIBE_SCHEMA = {
  type: "object",
  properties: {
    commitMessage: { type: "string", description: "Conventional Commits 형식 한국어 커밋 메시지. 제목 한 줄, 필요하면 빈 줄 뒤 본문" },
    prTitle: { type: "string", description: "PR 제목 한 줄 (한국어)" },
    prBody: { type: "string", description: "PR 본문 Markdown (한국어): 변경 요약, 변경 이유, 확인할 점" },
  },
  required: ["commitMessage", "prTitle", "prBody"],
  additionalProperties: false,
};

// 아직 원격에 올라가지 않은 커밋 범위.
// push한 적이 있으면 그때의 HEAD 기준이라, squash 머지 후 원격 브랜치가 지워져도 정확하다.
function pendingRange(ws: Worktree, state: ThreadState): string {
  return `${state.pushedHead ?? ws.base}..HEAD`;
}

// 스레드의 작업 세션을 분기해서, 대화 맥락과 diff를 보고 커밋 메시지·PR 설명만 쓰게 한다.
// 분기하므로 원래 세션에는 이 요청이 남지 않는다.
// 커밋 메시지는 이번에 커밋할 변경(staged)만, PR 설명은 base 대비 브랜치 전체를 기준으로 쓴다.
// base는 다른 스레드의 fetch로 앞서갈 수 있으므로 merge-base와 비교한다.
async function describeChanges(ws: Worktree, sessionId: string | undefined): Promise<Description> {
  const staged = (await git(ws.cwd, "diff", "--cached")).slice(0, DIFF_LIMIT / 2);
  const stat = await git(ws.cwd, "diff", "--cached", "--merge-base", "--stat", ws.base);
  const whole = (await git(ws.cwd, "diff", "--cached", "--merge-base", ws.base)).slice(0, DIFF_LIMIT);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), config.jobTimeoutMs);
  try {
    const q = query({
      prompt: [
        "이 브랜치의 작업을 커밋하고 draft PR을 만들려고 한다.",
        "commitMessage는 [이번 커밋 diff]만, prTitle·prBody는 [브랜치 전체 diff]를 기준으로 작성해줘.",
        `\n[이번 커밋 diff]\n${staged || "(없음)"}`,
        `\n[브랜치 전체 diff] (base: ${ws.base})\n${stat}\n\n${whole}`,
      ].join("\n"),
      options: {
        cwd: ws.cwd,
        resume: sessionId,
        forkSession: true,
        model: config.model,
        tools: [],
        // tools는 내장 도구만 비우고 MCP 도구(Slack 전송 등)는 그대로 붙으므로 따로 뺀다
        strictMcpConfig: true,
        maxTurns: 3,
        outputFormat: { type: "json_schema", schema: DESCRIBE_SCHEMA },
        abortController: abort,
      },
    });

    for await (const m of q) {
      if (m.type === "result") {
        if (m.subtype === "success" && m.structured_output) return m.structured_output as Description;
        throw new Error(`커밋 메시지 작성 실패 (${m.subtype})`);
      }
    }
    throw new Error("커밋 메시지 작성 실패 (결과 없음)");
  } catch (err) {
    if (abort.signal.aborted) throw new Error("커밋 메시지 작성 시간이 초과됐어요");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// !pr: 커밋 → push 승인 → push → (PR이 없으면) draft PR 생성. PR이 이미 있으면 push로 갱신만 한다.
export async function openPullRequest(thread: ThreadChannel, state: ThreadState) {
  const ws = state.workspace;
  if (ws.kind !== "worktree") {
    await thread.send("`!pr`은 `@태그`로 시작한 레포 작업 스레드에서만 쓸 수 있어요.");
    return;
  }

  let description: Description | undefined;

  if (await hasUncommitted(ws.cwd)) {
    await thread.send("📝 커밋 메시지 작성 중…");
    await git(ws.cwd, "add", "-A");
    description = await describeChanges(ws, state.sessionId);
    await commitAll(ws.cwd, description.commitMessage);
  }

  const ghUser = config.projects[ws.tag]?.ghUser;
  const token = ghUser ? await ghToken(ghUser) : undefined;
  const range = pendingRange(ws, state);
  const count = await commitCount(ws.cwd, range);

  if (count === 0) {
    if (state.prUrl) {
      await thread.send(`새로 올릴 변경이 없어요. PR: ${state.prUrl}`);
      return;
    }
    if (!state.pushedHead) {
      await thread.send("올릴 변경 사항이 없어요.");
      return;
    }
    // push는 됐는데 지난번 PR 생성이 실패한 경우: push 없이 PR 생성만 다시 시도한다
  } else {
    const log = await git(ws.cwd, "log", "--oneline", range);
    const files = await git(ws.cwd, "diff", "--stat", range);
    const origin = await git(ws.cwd, "remote", "get-url", "origin");
    const approved = await askApproval(
      thread,
      `🚀 push 승인 요청\n레포: ${origin}${ghUser ? ` (계정: ${ghUser})` : ""}\n브랜치: \`${ws.branch}\` (커밋 ${count}개)\n\`\`\`\n${log.slice(0, 600)}\n\n${files.slice(0, 800)}\n\`\`\``,
    );
    if (!approved) {
      await thread.send("push하지 않았어요. 커밋은 로컬 브랜치에 남아 있고, 다시 `!pr`로 올릴 수 있어요.");
      return;
    }

    await pushBranch(ws.cwd, ws.branch, token);
    const pushedHead = await git(ws.cwd, "rev-parse", "HEAD");
    sessions.set(thread.id, { ...sessions.get(thread.id)!, pushedHead, cleanupWarned: false });

    if (state.prUrl) {
      await thread.send(`⬆️ PR에 반영했어요: ${state.prUrl}`);
      return;
    }
  }

  // 커밋 없이 PR만 만드는 경우(push 거부 후 재시도, PR 생성 실패 후 재시도)에는 쓸 설명이 없으므로 새로 만든다
  description ??= await describeChanges(ws, state.sessionId);
  const url = await createDraftPr(
    ws.cwd,
    { base: ws.base.replace(/^origin\//, ""), head: ws.branch, title: description.prTitle, body: description.prBody },
    token,
  );
  sessions.set(thread.id, { ...sessions.get(thread.id)!, prUrl: url });
  await thread.send(`🔗 draft PR을 만들었어요: ${url}`);
}

// 정리할 대상. 보관은 스레드에 경고하고, 삭제는 스레드가 없으므로 부모 채널에 알린다.
// 삭제는 discord.js 캐시에 없는 스레드도 처리해야 해서 스레드 객체 대신 ID와 알림 함수만 받는다.
export type CleanupTarget =
  | { kind: "archived"; thread: ThreadChannel }
  | { kind: "deleted"; threadId: string; label: string; notify?: (content: string) => Promise<unknown> };

// 스레드 보관·삭제 시: 커밋·push 안 된 작업이 남아 있으면 지우지 않는다
export async function cleanupThread(target: CleanupTarget, state: ThreadState) {
  const ws = state.workspace;
  if (ws.kind !== "worktree") return;
  const threadId = target.kind === "archived" ? target.thread.id : target.threadId;

  // 폴더가 이미 없으면(수동 삭제, 지난 정리의 부분 실패) 남은 브랜치·기록만 치운다
  if (!existsSync(ws.cwd)) {
    await git(ws.repo, "branch", "-D", ws.branch).catch(() => {});
    sessions.delete(threadId);
    console.log(`🧹 기록만 정리 (폴더 없음): ${ws.cwd}`);
    return;
  }

  const dirty = await hasUncommitted(ws.cwd);
  const unpushed = dirty ? 0 : await commitCount(ws.cwd, pendingRange(ws, state));

  if (dirty || unpushed > 0) {
    const reason = dirty ? "커밋되지 않은 변경이" : `push되지 않은 커밋 ${unpushed}개가`;
    if (target.kind === "deleted") {
      // 이어갈 스레드가 없으므로 기록은 지우고, 작업 공간만 남겨 직접 정리하게 한다
      sessions.delete(threadId);
      console.log(`📦 삭제된 스레드의 작업 공간 보존: ${ws.cwd}`);
      await target.notify?.(
        `⚠️ 삭제된 스레드 ${target.label}에 ${reason} 남아 있어 작업 공간을 지우지 않았어요.\n` +
          `폴더: \`${ws.cwd}\`\n브랜치: \`${ws.branch}\`\n` +
          `필요 없으면 직접 정리해주세요:\n\`\`\`\ngit -C "${ws.repo}" worktree remove --force "${ws.cwd}"\ngit -C "${ws.repo}" branch -D ${ws.branch}\n\`\`\``,
      );
      return;
    }
    if (state.cleanupWarned) return;
    sessions.set(threadId, { ...state, cleanupWarned: true });
    await target.thread.send(
      `⚠️ 스레드가 닫혔지만 ${reason} 남아 있어 작업 공간을 정리하지 않았어요. \`!pr\`로 올린 뒤 다시 닫아주세요.`,
    );
    return;
  }

  await removeWorktree(ws);
  sessions.delete(threadId);
  console.log(`🧹 정리 완료: ${ws.cwd}`);
}
