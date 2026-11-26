import { git } from "./git.js";
import type { Workspace } from "./workspace.js";

type Worktree = Extract<Workspace, { kind: "worktree" }>;

const DIFF_LIMIT = 30_000;

// lockfile은 diff가 커서 예산을 먼저 차지해 코드 diff가 잘리므로 본문에서 뺀다 (변경 파일 목록에는 남는다)
const SKIP_LOCKFILES = ["--", ".", ":(exclude)*.lock", ":(exclude)*-lock.json", ":(exclude)*-lock.yaml"];

// 리뷰어는 코드를 고치지 않는다. 읽기 도구만 주고, 지적은 다음 작업 요청에 넘겨 원래 세션이 고친다.
export const REVIEW_TOOLS = ["Read", "Grep", "Glob"];

export const REVIEW_HINT = [
  "You are a code reviewer running as a Discord-driven agent inside a git worktree. You can only read files.",
  "Review the given diff for bugs, security issues, missed edge cases, and maintainability problems.",
  "Read surrounding code when the diff alone is not enough to judge. Do not report style nits that a linter would catch.",
  "Reply in Korean Markdown, conclusion first: one line verdict, then findings grouped by severity (HIGH / MEDIUM / LOW),",
  "each with `file:line`, the problem, and a concrete fix. If there is nothing worth fixing, say so briefly.",
].join(" ");

// 커밋 여부와 상관없이 base에서 갈라진 뒤의 모든 변경(작업 트리 포함)을 리뷰한다.
// base는 다른 스레드의 fetch로 앞서갈 수 있으므로 merge-base와 비교한다.
export async function buildReviewPrompt(ws: Worktree): Promise<string | undefined> {
  const stat = await git(ws.cwd, "diff", "--merge-base", "--stat", ws.base);
  const diff = await git(ws.cwd, "diff", "--merge-base", ws.base, ...SKIP_LOCKFILES);
  const untracked = await git(ws.cwd, "ls-files", "--others", "--exclude-standard");
  if (!diff && !untracked) return undefined;

  const truncated = diff.length > DIFF_LIMIT;
  return [
    `이 브랜치(base: ${ws.base})의 변경을 리뷰해줘.`,
    stat && `\n[변경 파일]\n${stat}`,
    untracked && `\n[새 파일 (diff에 없음, 직접 읽어서 리뷰)]\n${untracked}`,
    diff && `\n[diff]${truncated ? " (길어서 잘림, 나머지는 파일을 직접 읽어서 리뷰)" : ""} (lockfile 생략)\n${diff.slice(0, DIFF_LIMIT)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// 재리뷰: 직전 리뷰 시점 이후 바뀐 부분과 이전 지적만 넘겨, 처음부터 다시 리뷰하지 않게 한다
export async function buildReReviewPrompt(
  ws: Worktree,
  prev: { text: string; tree: string },
  tree: string,
): Promise<string | undefined> {
  const stat = await git(ws.cwd, "diff", "--stat", prev.tree, tree);
  if (!stat) return undefined;
  const diff = await git(ws.cwd, "diff", prev.tree, tree, ...SKIP_LOCKFILES);

  const truncated = diff.length > DIFF_LIMIT;
  return [
    "직전 리뷰 이후 바뀐 부분을 재리뷰해줘.",
    "1) 이전 지적마다 해결 / 미해결 / 부분 해결을 판정하고, 2) 아래 diff에서 새로 생긴 문제만 찾아줘.",
    "바뀌지 않은 코드는 이미 리뷰했으니 다시 지적하지 마. 판정에 필요하면 파일을 직접 읽어도 돼.",
    "답변 형식: 한 줄 결론 → [이전 지적] 항목별 판정 → [새 지적] 심각도별.",
    `\n[이전 리뷰]\n${prev.text}`,
    `\n[직전 리뷰 이후 변경 파일]\n${stat}`,
    `\n[diff]${truncated ? " (길어서 잘림, 나머지는 파일을 직접 읽어서 리뷰)" : ""} (lockfile 생략)\n${diff.slice(0, DIFF_LIMIT)}`,
  ].join("\n");
}

// 리뷰 결과를 다음 작업 요청 앞에 붙여, 원래 작업 세션이 지적 사항을 보고 고칠 수 있게 한다
export function withReview(prompt: string, review: string): string {
  return `[직전 !review 결과]\n${review}\n\n[요청]\n${prompt}`;
}
