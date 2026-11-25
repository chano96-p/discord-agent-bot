import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { Workspace } from "./workspace.js";

// 스레드 하나 = 작업 하나. 후속 메시지는 같은 작업 공간과 세션으로 이어진다.
export type ThreadState = {
  workspace: Workspace;
  sessionId?: string;
  prUrl?: string;
  // 마지막으로 push한 커밋. squash 머지 후 원격 브랜치가 지워져도 "push 안 된 커밋"을 정확히 세기 위해 기록한다
  pushedHead?: string;
  cleanupWarned?: boolean; // 보관 시 정리를 못 해 경고를 한 번 보냈는지 (보관/해제 반복 시 중복 경고 방지)
};

const file = path.join(config.root, "sessions.json");
const store: Record<string, ThreadState> = existsSync(file)
  ? JSON.parse(readFileSync(file, "utf8"))
  : {};

// base 필드가 생기기 전에 저장된 worktree 세션은 projects.json 값으로 채운다
for (const state of Object.values(store)) {
  const ws = state.workspace;
  if (ws.kind === "worktree" && !ws.base) {
    const base = config.projects[ws.tag]?.base;
    if (base) ws.base = base;
  }
}

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
  delete(threadId: string) {
    delete store[threadId];
    save();
  },
};
