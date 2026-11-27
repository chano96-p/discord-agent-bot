import {
  Client,
  Events,
  GatewayDispatchEvents,
  GatewayIntentBits,
  MessageFlags,
  type GatewayThreadDeleteDispatchData,
  type Message,
  type ThreadChannel,
} from "discord.js";
import { FIX_PROMPT, NEXT_LABEL, NEXT_PREFIX, nextButtons, type NextAction } from "./actions.js";
import { config } from "./config.js";
import { cleanupThread, openPullRequest, type CleanupTarget } from "./pr.js";
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
// 작업·정리 중에 삭제돼 정리를 미룬 스레드. 끝나는 쪽(enqueue·cleanup의 finally)에서 꺼내 정리한다
const deletedWhileBusy = new Map<string, CleanupTarget>();

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
  const { tag, unknownTag, prompt } = parseTag(msg.content);
  if (unknownTag) {
    const known = Object.keys(config.projects).map((t) => `\`@${t}\``).join(", ") || "없음";
    await msg.reply(`등록되지 않은 태그예요: \`@${unknownTag}\`\n등록된 태그: ${known}\n태그 없이 맡기려면 \`@\` 없이 보내주세요.`);
    return;
  }
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

  if (text === "!pr") return runAction(thread, "pr");
  if (text === "!review") return runAction(thread, "review");

  if (text === "!review all") {
    await enqueue(thread, () => runReview(thread, true));
    return;
  }

  await enqueue(thread, () => runJob(thread, text));
}

// 명령 입력과 다음 행동 버튼이 같은 경로로 실행된다
async function runAction(thread: ThreadChannel, action: NextAction) {
  if (action === "review") return enqueue(thread, () => runReview(thread, false));
  if (action === "fix") {
    // 이전 리뷰 메시지의 버튼을 누른 경우: 리뷰 결과가 이미 다음 요청에 쓰였으면 고칠 기준이 없다
    if (!sessions.get(thread.id)?.pendingReview) {
      await thread.send("넘길 리뷰 결과가 없어요. `!review`로 다시 리뷰하거나 고칠 내용을 직접 보내주세요.");
      return;
    }
    return enqueue(thread, () => runJob(thread, FIX_PROMPT));
  }
  if (action === "pr") {
    // 대기열에서 기다리는 동안 상태가 바뀔 수 있으므로 실행 시점에 읽는다
    return enqueue(thread, () => openPullRequest(thread, sessions.get(thread.id)!));
  }
}

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isButton() || !i.customId.startsWith(NEXT_PREFIX)) return;
  // 리스너의 예외는 미처리 rejection으로 프로세스를 죽이므로 응답 실패도 잡는다
  const notice = (content: string) => i.reply({ content, flags: MessageFlags.Ephemeral }).catch(console.error);

  if (!config.ownerIds.has(i.user.id)) return notice("이 봇의 소유자만 누를 수 있어요.");
  const thread = i.channel;
  if (!thread?.isThread()) return;

  const action = i.customId.slice(NEXT_PREFIX.length) as NextAction;
  // 재시작 전 메시지에 남은, 이름이 바뀌었거나 없어진 버튼
  if (!Object.hasOwn(NEXT_LABEL, action)) return notice("더 이상 쓰지 않는 버튼이에요.");
  // 진행 중이면 버튼을 지우지 않고 남겨, 끝난 뒤 다시 누를 수 있게 한다
  if (inFlight.has(thread.id)) return notice("이 스레드의 이전 작업이 아직 진행 중이에요. 끝난 뒤 다시 눌러주세요.");

  try {
    // 버튼을 지워 두 번 누르지 않게 하고, 무엇을 골랐는지 남긴다
    await i.update({ content: `${i.message.content}\n→ ${NEXT_LABEL[action]}`, components: [] });

    if (!sessions.get(thread.id)) {
      await thread.send("작업 공간이 이미 정리된 스레드예요.");
      return;
    }
    await runAction(thread, action);
  } catch (err) {
    console.error(err);
    await thread.send(`오류: ${(err as Error).message}`).catch(() => {});
  }
});

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
      // 작업 중에 보관·삭제된 스레드는 그 이벤트 때 건너뛰었으므로 지금 정리한다
      if (!runDeferredDelete(thread.id) && thread.archived) void cleanup({ kind: "archived", thread });
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
        await thread.send({
          content: `변경된 파일 (브랜치 \`${workspace.branch}\`)\n\`\`\`\n${stat.slice(0, 1500)}\n\`\`\``,
          components: [nextButtons(["review", "pr"])],
        });
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
    await thread.send({
      content: "💬 버튼을 누르거나, 고칠 내용을 직접 보내면 위 리뷰를 참고해 작업해요. (예: `HIGH만 고쳐줘`)",
      components: [nextButtons(["fix", "pr"])],
    });
  } finally {
    running.delete(thread.id);
  }
}

// ── 6. 스레드 보관(닫기·자동 보관)·삭제 → 작업 공간 정리 ─────────────────
client.on(Events.ThreadUpdate, async (before, after) => {
  if (before.archived || !after.archived) return;
  await cleanup({ kind: "archived", thread: after });
});

// discord.js의 ThreadDelete 이벤트는 캐시에 있는 스레드만 오는데, 보관된 스레드는 4시간 뒤 캐시에서 빠지고
// 재시작 후에는 아예 없다. 그래서 게이트웨이 패킷을 직접 받는다. 패킷 처리(캐시 제거)보다 먼저 호출된다.
client.ws.on(GatewayDispatchEvents.ThreadDelete, (d: GatewayThreadDeleteDispatchData) => {
  onThreadDelete(d).catch(console.error);
});

async function onThreadDelete(d: GatewayThreadDeleteDispatchData) {
  // 첫 작업이 작업 공간을 준비하는 중이면 세션이 아직 없으므로 inFlight도 본다
  if (!sessions.get(d.id) && !inFlight.has(d.id)) return;

  const name = (client.channels.cache.get(d.id) as ThreadChannel | undefined)?.name;
  const parent = d.parent_id ? client.channels.cache.get(d.parent_id) : undefined;
  const target: CleanupTarget = {
    kind: "deleted",
    threadId: d.id,
    label: name ? `「${name}」` : `(ID ${d.id})`,
    notify: parent?.isSendable() ? (content) => parent.send(content) : undefined,
  };

  // 결과를 보낼 스레드가 없으므로 실행 중인 작업은 멈추고, 끝난 쪽에서 정리한다
  running.get(d.id)?.abort();
  if (inFlight.has(d.id)) deletedWhileBusy.set(d.id, target);
  else await cleanup(target);
}

function runDeferredDelete(threadId: string): boolean {
  const target = deletedWhileBusy.get(threadId);
  if (!target) return false;
  deletedWhileBusy.delete(threadId);
  void cleanup(target);
  return true;
}

// 정리 중에도 inFlight로 표시해, 그 사이 들어온 요청이 지워지는 작업 공간에서 실행되지 않게 한다
async function cleanup(target: CleanupTarget) {
  const threadId = target.kind === "archived" ? target.thread.id : target.threadId;
  const state = sessions.get(threadId);
  if (!state || inFlight.has(threadId)) return;
  inFlight.add(threadId);
  try {
    await cleanupThread(target, state);
  } catch (err) {
    console.error(err);
  } finally {
    inFlight.delete(threadId);
    // 보관 정리 중에 삭제된 경우
    runDeferredDelete(threadId);
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
