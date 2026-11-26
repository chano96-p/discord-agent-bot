import { Client, Events, GatewayIntentBits, type Message, type ThreadChannel } from "discord.js";
import { config } from "./config.js";
import { cleanupThread, openPullRequest } from "./pr.js";
import { JobQueue } from "./queue.js";
import { snapshotTree } from "./git.js";
import { buildReReviewPrompt, buildReviewPrompt, REVIEW_HINT, REVIEW_TOOLS, withReview } from "./review.js";
import { sendFiles, sendText } from "./reply.js";
import { runClaude } from "./runner.js";
import { sessions, type ThreadState } from "./sessions.js";
import { diffStat, listOutputs, parseTag, prepareWorkspace } from "./workspace.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const queue = new JobQueue(config.maxConcurrent);
const running = new Map<string, AbortController>(); // threadId → 실행 중인 작업
const inFlight = new Set<string>(); // 대기 + 실행 중인 스레드

// ── 1. 봇 프로세스: 누가, 어디서 보낸 메시지인지 거른다 ─────────────
function isAllowed(msg: Message): boolean {
  if (msg.author.bot) return false; // 1단계는 사람 요청만 처리
  if (!config.ownerIds.has(msg.author.id)) return false;
  const channelId = msg.channel.isThread() ? msg.channel.parentId : msg.channelId;
  return !!channelId && config.channelIds.has(channelId);
}

client.on(Events.MessageCreate, async (msg) => {
  if (!isAllowed(msg)) return;
  try {
    if (msg.channel.isThread()) await onThreadMessage(msg, msg.channel);
    else await onNewRequest(msg);
  } catch (err) {
    console.error(err);
    await msg.reply(`오류: ${(err as Error).message}`).catch(() => {});
  }
});

// 채널에 새 메시지 → 스레드를 열고 새 작업으로 등록
async function onNewRequest(msg: Message) {
  const { tag, prompt } = parseTag(msg.content);
  if (!prompt) return;
  const thread = await msg.startThread({ name: prompt.slice(0, 80) });
  await enqueue(thread, () => runJob(thread, prompt, tag));
}

// 스레드 안 메시지 → 같은 작업 공간·세션으로 이어서 작업
async function onThreadMessage(msg: Message, thread: ThreadChannel) {
  const text = msg.content.trim();

  if (text === "!stop") {
    const ctrl = running.get(thread.id);
    if (ctrl) {
      ctrl.abort();
      await msg.react("🛑");
    } else {
      await msg.reply("실행 중인 작업이 없습니다.");
    }
    return;
  }

  const state = sessions.get(thread.id);
  if (!state) return; // 봇이 만든 스레드가 아니면 무시

  if (text === "!pr") {
    await enqueue(thread, () => openPullRequest(thread, state));
    return;
  }

  if (text === "!review" || text === "!review all") {
    await enqueue(thread, () => runReview(thread, text === "!review all"));
    return;
  }

  await enqueue(thread, () => runJob(thread, text));
}

// ── 2. 작업 큐 ────────────────────────────────────────────────
async function enqueue(thread: ThreadChannel, task: () => Promise<void>) {
  if (inFlight.has(thread.id)) {
    await thread.send("이 스레드의 이전 작업이 아직 진행 중이에요. 끝난 뒤 다시 보내주세요.");
    return;
  }
  inFlight.add(thread.id);
  if (queue.isFull) await thread.send(`⏸️ 대기 중 (대기열 ${queue.pending + 1}번째)`);

  queue
    .run(task)
    .catch(async (err) => {
      console.error(err);
      await thread.send(`오류: ${(err as Error).message}`).catch(() => {});
    })
    .finally(() => {
      inFlight.delete(thread.id);
      // 작업 중에 보관된 스레드는 보관 이벤트 때 건너뛰었으므로 지금 정리한다
      if (thread.archived) void cleanup(thread);
    });
}

// ── 3~5. 작업 공간 준비 → Claude 실행 → 세션 저장 → 결과 회신 ─────────
async function runJob(thread: ThreadChannel, prompt: string, tag?: string) {
  let state: ThreadState | undefined = sessions.get(thread.id);

  if (!state) {
    await thread.send(tag ? `📁 \`${tag}\` worktree 준비 중…` : "📁 작업 폴더 준비 중…");
    state = { workspace: await prepareWorkspace(tag) };
    sessions.set(thread.id, state);
  }

  const { workspace } = state;
  const before = await listOutputs(workspace);
  const abort = new AbortController();
  running.set(thread.id, abort);

  const fullPrompt = state.pendingReview ? withReview(prompt, state.pendingReview) : prompt;
  if (state.pendingReview) await thread.send("📎 직전 `!review` 결과를 함께 전달했어요.");

  try {
    const result = await runClaude({ prompt: fullPrompt, workspace, resume: state.sessionId, thread, abort });
    // 중단·실패하면 리뷰 결과를 남겨 다음 요청에 다시 붙인다
    const pendingReview = result.ok ? undefined : state.pendingReview;
    sessions.set(thread.id, { ...state, sessionId: result.sessionId ?? state.sessionId, pendingReview });

    await sendText(thread, result.text);

    const after = await listOutputs(workspace);
    await sendFiles(thread, after.filter((f) => !before.includes(f)));

    if (workspace.kind === "worktree") {
      const stat = await diffStat(workspace);
      if (stat) {
        await thread.send(
          `변경된 파일 (브랜치 \`${workspace.branch}\`)\n\`\`\`\n${stat.slice(0, 1500)}\n\`\`\``,
        );
      }
    }
  } finally {
    running.delete(thread.id);
  }
}

// !review: 작업 세션과 분리된 새 세션이 읽기 도구만으로 리뷰한다.
// 작업 대화를 이어받지 않아야 작업자의 판단에 끌려가지 않는다. 두 번째부터는 직전 리뷰 이후 바뀐 부분만 보고,
// !review all이면 처음처럼 브랜치 전체를 리뷰한 뒤 그 결과를 다음 재리뷰의 기준으로 삼는다.
async function runReview(thread: ThreadChannel, full: boolean) {
  const state = sessions.get(thread.id);
  const ws = state?.workspace;
  if (ws?.kind !== "worktree") {
    await thread.send("`!review`는 `@태그`로 시작한 레포 작업 스레드에서만 쓸 수 있어요.");
    return;
  }

  const prev = full ? undefined : state!.lastReview;
  const tree = await snapshotTree(ws.cwd);
  const prompt = prev ? await buildReReviewPrompt(ws, prev, tree) : await buildReviewPrompt(ws);
  if (!prompt) {
    await thread.send(prev ? "직전 리뷰 이후 바뀐 부분이 없어요." : "리뷰할 변경이 없어요.");
    return;
  }
  if (prev) await thread.send("🔁 직전 리뷰 이후 바뀐 부분만 재리뷰해요.");

  const abort = new AbortController();
  running.set(thread.id, abort);
  try {
    const result = await runClaude({ prompt, workspace: ws, thread, abort, tools: REVIEW_TOOLS, hint: REVIEW_HINT });
    await sendText(thread, result.text);
    if (!result.ok) return;
    sessions.set(thread.id, { ...sessions.get(thread.id)!, pendingReview: result.text, lastReview: { text: result.text, tree } });
    await thread.send("💬 고칠 내용을 이 스레드에 보내면 위 리뷰를 참고해 작업해요. (예: `HIGH만 고쳐줘`)");
  } finally {
    running.delete(thread.id);
  }
}

// ── 6. 스레드 보관(닫기·자동 보관) → 작업 공간 정리 ─────────────────
client.on(Events.ThreadUpdate, async (before, after) => {
  if (before.archived || !after.archived) return;
  await cleanup(after);
});

// 정리 중에도 inFlight로 표시해, 그 사이 들어온 요청이 지워지는 작업 공간에서 실행되지 않게 한다
async function cleanup(thread: ThreadChannel) {
  const state = sessions.get(thread.id);
  if (!state || inFlight.has(thread.id)) return;
  inFlight.add(thread.id);
  try {
    await cleanupThread(thread, state);
  } catch (err) {
    console.error(err);
  } finally {
    inFlight.delete(thread.id);
  }
}

// ── 시작 / 종료 ───────────────────────────────────────────────
client.once(Events.ClientReady, (c) => {
  console.log(`✅ ${c.user.tag} 온라인 · 채널 ${config.channelIds.size}개 · 프로젝트 ${Object.keys(config.projects).join(", ") || "없음"}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    for (const ctrl of running.values()) ctrl.abort();
    client.destroy().finally(() => process.exit(0));
  });
}

client.login(config.token);
