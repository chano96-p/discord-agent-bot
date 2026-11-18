import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { Workspace } from "./workspace.js";

// 스레드 하나 = 작업 하나. 후속 메시지는 같은 작업 공간과 세션으로 이어진다.
export type ThreadState = { workspace: Workspace; sessionId?: string };

const file = path.join(config.root, "sessions.json");
const store: Record<string, ThreadState> = existsSync(file)
  ? JSON.parse(readFileSync(file, "utf8"))
  : {};

function save() {
  mkdirSync(config.root, { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 2));
}

export const sessions = {
  get: (threadId: string) => store[threadId],
  set(threadId: string, state: ThreadState) {
    store[threadId] = state;
    save();
  },
};
