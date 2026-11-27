import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

// 작업·리뷰가 끝난 뒤 띄우는 "다음 행동" 버튼. 누르면 같은 명령을 입력한 것과 똑같이 동작한다.
export type NextAction = "review" | "fix" | "pr";

export const NEXT_PREFIX = "next:";

export const NEXT_LABEL: Record<NextAction, string> = {
  review: "🔍 리뷰",
  fix: "🛠️ 지적 사항 고치기",
  pr: "🚀 PR",
};

// 리뷰어가 틀릴 수도 있으므로 무조건 따르지 말고, 동의하지 않는 지적은 이유를 남기게 한다
export const FIX_PROMPT = "위 리뷰의 지적 사항을 고쳐줘. 동의하지 않는 지적은 고치지 말고 이유를 알려줘.";

export function nextButtons(actions: NextAction[]) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    actions.map((a) =>
      new ButtonBuilder()
        .setCustomId(`${NEXT_PREFIX}${a}`)
        .setLabel(NEXT_LABEL[a])
        .setStyle(a === "pr" ? ButtonStyle.Success : ButtonStyle.Secondary),
    ),
  );
}
