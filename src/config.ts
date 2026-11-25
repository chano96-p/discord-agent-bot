import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const expand = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir());
const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`.env에 ${name}가 없습니다`);
  return v;
}

// ghUser: push·PR을 활성 gh 계정 대신 이 계정으로 한다 (gh auth login으로 등록된 계정이어야 함)
export type Project = { repo: string; base: string; install?: string; ghUser?: string };

function loadProjects(): Record<string, Project> {
  const file = path.resolve("projects.json");
  if (!existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, Project>;
  return Object.fromEntries(
    Object.entries(raw).map(([tag, p]) => [tag, { ...p, repo: expand(p.repo) }]),
  );
}

export const config = {
  token: required("DISCORD_BOT_TOKEN"),
  ownerIds: new Set(list(process.env.OWNER_IDS)),
  channelIds: new Set(list(process.env.CHANNEL_IDS)),
  root: expand(process.env.AGENT_ROOT ?? "~/.agent"),
  maxConcurrent: Number(process.env.MAX_CONCURRENT ?? 2),
  jobTimeoutMs: Number(process.env.JOB_TIMEOUT_SEC ?? 900) * 1000,
  model: process.env.CLAUDE_MODEL || undefined,
  projects: loadProjects(),
};
