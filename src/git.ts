import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function exec(cmd: string, args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  try {
    const { stdout } = await run(cmd, args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : undefined,
    });
    return stdout.trim();
  } catch (err) {
    const e = err as Error & { stderr?: string };
    // "-c key=value" 같은 전역 옵션을 건너뛰고 실제 서브커맨드(push 등)를 표시한다
    const sub = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c") ?? args[0];
    throw new Error(`${cmd} ${sub} 실패: ${(e.stderr || e.message).trim().slice(0, 800)}`);
  }
}

export const git = (cwd: string, ...args: string[]) => exec("git", args, cwd);

// 활성 gh 계정을 바꾸지 않고, 이 계정의 토큰을 봇이 실행하는 명령에만 넘긴다
export async function ghToken(user: string): Promise<string> {
  return exec("gh", ["auth", "token", "--user", user], process.cwd());
}

export async function hasUncommitted(cwd: string): Promise<boolean> {
  return (await git(cwd, "status", "--porcelain")) !== "";
}

export async function commitCount(cwd: string, range: string): Promise<number> {
  return Number(await git(cwd, "rev-list", "--count", range));
}

// 커밋하지 않은 변경과 새 파일까지 포함한 작업 트리 상태를 tree 객체로 남긴다.
// 임시 index를 써서 실제 index·작업 트리는 건드리지 않는다.
export async function snapshotTree(cwd: string): Promise<string> {
  const index = path.join(os.tmpdir(), `agent-bot-index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await exec("git", ["read-tree", "HEAD"], cwd, env);
    await exec("git", ["add", "-A"], cwd, env);
    return await exec("git", ["write-tree"], cwd, env);
  } finally {
    await rm(index, { force: true });
  }
}

export async function commitAll(cwd: string, message: string) {
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", message);
}

// 토큰이 있으면 전역 credential helper(GCM)를 비우고 토큰으로 인증한다.
// GCM은 저장된 자격 증명이 없으면 브라우저 로그인을 띄우려 해서, 백그라운드 봇에서는 멈출 수 있다.
const TOKEN_HELPER = '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';

export async function pushBranch(cwd: string, branch: string, token?: string) {
  if (!token) return exec("git", ["push", "-u", "origin", branch], cwd);
  return exec(
    "git",
    ["-c", "credential.helper=", "-c", `credential.helper=${TOKEN_HELPER}`, "push", "-u", "origin", branch],
    cwd,
    { GH_TOKEN: token, GIT_TERMINAL_PROMPT: "0" },
  );
}

export async function createDraftPr(
  cwd: string,
  opts: { base: string; head: string; title: string; body: string },
  token?: string,
): Promise<string> {
  const out = await exec(
    "gh",
    ["pr", "create", "--draft", "--base", opts.base, "--head", opts.head, "--title", opts.title, "--body", opts.body],
    cwd,
    token ? { GH_TOKEN: token } : undefined,
  );
  return out.split("\n").pop() ?? out;
}
