import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";

const run = promisify(execFile);

export type Workspace =
  | { kind: "job"; jobId: string; cwd: string }
  | { kind: "worktree"; jobId: string; cwd: string; tag: string; repo: string; branch: string };

export function newJobId() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `job-${ymd}-${Math.random().toString(36).slice(2, 6)}`;
}

// "@side 로그인 폼 고쳐줘" → { tag: "side", prompt: "로그인 폼 고쳐줘" }
export function parseTag(text: string) {
  const m = text.match(/^@(\w+)\s+([\s\S]*)$/);
  if (m && config.projects[m[1]]) return { tag: m[1], prompt: m[2].trim() };
  return { tag: undefined, prompt: text.trim() };
}

export async function prepareWorkspace(tag: string | undefined): Promise<Workspace> {
  const jobId = newJobId();

  if (!tag) {
    const cwd = path.join(config.root, "jobs", jobId);
    await mkdir(path.join(cwd, "outputs"), { recursive: true });
    return { kind: "job", jobId, cwd };
  }

  const project = config.projects[tag];
  const cwd = path.join(config.root, "worktrees", tag, jobId);
  const branch = `agent/${jobId}`;

  await mkdir(path.dirname(cwd), { recursive: true });
  await run("git", ["fetch", "origin"], { cwd: project.repo });
  await run("git", ["worktree", "add", "-b", branch, cwd, project.base], { cwd: project.repo });
  await copyFile(path.join(project.repo, ".env"), path.join(cwd, ".env")).catch(() => {});
  if (project.install) await run("sh", ["-c", project.install], { cwd });

  return { kind: "worktree", jobId, cwd, tag, repo: project.repo, branch };
}

// job 모드: outputs/ 안의 파일 목록 (실행 전후 비교용)
export async function listOutputs(ws: Workspace): Promise<string[]> {
  if (ws.kind !== "job") return [];
  const dir = path.join(ws.cwd, "outputs");
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
}

// worktree 모드: 변경 요약
export async function diffStat(ws: Workspace): Promise<string> {
  if (ws.kind !== "worktree") return "";
  const { stdout } = await run("git", ["status", "--short"], { cwd: ws.cwd });
  return stdout.trim();
}
