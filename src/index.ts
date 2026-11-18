import { Client, Events, GatewayIntentBits, type Message, type ThreadChannel } from "discord.js";
import { config } from "./config.js";
import { JobQueue } from "./queue.js";
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
  await enqueue(thread, prompt, tag);
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

  if (!sessions.get(thread.id)) return; // 봇이 만든 스레드가 아니면 무시
  await enqueue(thread, text);
}

// ── 2. 작업 큐 ────────────────────────────────────────────────
async function enqueue(thread: ThreadChannel, prompt: string, tag?: string) {
  if (inFlight.has(thread.id)) {
    await thread.send("이 스레드의 이전 작업이 아직 진행 중이에요. 끝난 뒤 다시 보내주세요.");
    return;
  }
  inFlight.add(thread.id);
  if (queue.isFull) await thread.send(`⏸️ 대기 중 (대기열 ${queue.pending + 1}번째)`);

  queue
    .run(() => runJob(thread, prompt, tag))
    .catch(async (err) => {
      console.error(err);
      await thread.send(`오류: ${(err as Error).message}`).catch(() => {});
    })
    .finally(() => inFlight.delete(thread.id));
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

  try {
    const result = await runClaude({ prompt, workspace, resume: state.sessionId, thread, abort });
    if (result.sessionId) sessions.set(thread.id, { ...state, sessionId: result.sessionId });

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
