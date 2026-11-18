import { AttachmentBuilder, type ThreadChannel } from "discord.js";
import path from "node:path";

const INLINE_LIMIT = 1900;
const MAX_FILES = 10;

// 짧으면 메시지로, 길면 response.md로 첨부
export async function sendText(thread: ThreadChannel, text: string) {
  if (!text) return;
  if (text.length <= INLINE_LIMIT) {
    await thread.send(text);
    return;
  }
  await thread.send({
    content: "응답이 길어서 파일로 첨부합니다.",
    files: [new AttachmentBuilder(Buffer.from(text, "utf8"), { name: "response.md" })],
  });
}

export async function sendFiles(thread: ThreadChannel, files: string[]) {
  if (files.length === 0) return;
  const picked = files.slice(0, MAX_FILES);
  await thread.send({
    content: `생성된 파일 ${files.length}개${files.length > MAX_FILES ? ` (앞의 ${MAX_FILES}개만 첨부)` : ""}`,
    files: picked.map((f) => new AttachmentBuilder(f, { name: path.basename(f) })),
  });
}
