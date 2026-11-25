import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type ThreadChannel,
} from "discord.js";
import { config } from "./config.js";

const APPROVAL_TIMEOUT_MS = 10 * 60_000;

function describe(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") return String(input.command ?? "");
  if ("file_path" in input) return String(input.file_path);
  if ("url" in input) return String(input.url);
  return JSON.stringify(input, null, 2).slice(0, 800);
}

// 스레드에 허용/거부 버튼을 띄우고, 소유자가 누를 때까지 기다린다. 시간 초과·중단은 거부로 본다.
export async function askApproval(thread: ThreadChannel, content: string, signal?: AbortSignal): Promise<boolean> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("allow").setLabel("허용").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("deny").setLabel("거부").setStyle(ButtonStyle.Danger),
  );
  const msg = await thread.send({ content, components: [row] });

  const aborted = new Promise<null>((resolve) =>
    signal?.addEventListener("abort", () => resolve(null), { once: true }),
  );
  const clicked = msg
    .awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => config.ownerIds.has(i.user.id),
      time: APPROVAL_TIMEOUT_MS,
    })
    .catch(() => null);

  const click = await Promise.race([clicked, aborted]);
  const allowed = click?.customId === "allow";
  const label = click ? (allowed ? "✅ 허용됨" : "⛔ 거부됨") : "⌛ 응답 없음 → 거부";

  if (click) await click.update({ content: `${msg.content}\n${label}`, components: [] });
  else await msg.edit({ content: `${msg.content}\n${label}`, components: [] }).catch(() => {});

  return allowed;
}

// Claude가 승인이 필요한 도구를 쓰려 할 때 호출된다. Claude는 버튼 응답까지 기다린다.
export function makeCanUseTool(thread: ThreadChannel): CanUseTool {
  return async (toolName, input, { signal }) => {
    const allowed = await askApproval(
      thread,
      `🔐 승인 요청: **${toolName}**\n\`\`\`\n${describe(toolName, input).slice(0, 1500)}\n\`\`\``,
      signal,
    );
    return allowed
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "사용자가 이 작업을 허용하지 않았습니다." };
  };
}
