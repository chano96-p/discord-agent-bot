# agent-bot (1단계: 봇 하나)

디스코드 메시지로 내 맥북의 Claude Code에 작업을 맡기는 봇.

```
src/
├── index.ts        봇 프로세스: 화이트리스트, 스레드 생성, !stop
├── queue.ts        작업 큐: 동시 실행 제한
├── workspace.ts    작업 공간: job 폴더 / 레포 worktree
├── runner.ts       Claude 실행기: Agent SDK, 진행 상황 표시, 타임아웃
├── permissions.ts  권한 승인: 디스코드 버튼
├── sessions.ts     세션 저장소: 스레드 → 작업 공간 + session_id
├── reply.ts        결과 회신: 긴 응답·생성 파일 첨부
└── config.ts       .env, projects.json 로드
```

## 준비

1. Discord Developer Portal에서 봇 생성 → 토큰 발급, **Message Content Intent** 켜기
2. OAuth2 URL Generator: scope `bot`, 권한은 채널 보기, 메시지 보내기, 공개 스레드 만들기, 스레드에서 메시지 보내기, 파일 첨부, 메시지 기록 보기, 반응 추가
3. 개발자 모드로 내 사용자 ID, 봇 전용 채널 ID 복사
4. 이 맥북에서 `claude`가 로그인된 상태인지 확인

## 실행

```bash
pnpm install            # 또는 npm install
cp .env.example .env    # 값 채우기
cp projects.example.json projects.json   # 태그로 쓸 레포 등록 (선택)
pnpm dev
```

## 사용

| 보내는 곳 | 메시지 | 동작 |
|---|---|---|
| 채널 | `이 CSV 정리해서 차트로 만들어줘` | 새 스레드 + job 폴더에서 작업 |
| 채널 | `@side 로그인 폼에 유효성 검사 추가해줘` | 새 스레드 + side 레포 worktree에서 작업 |
| 스레드 | `에러 메시지도 한국어로 바꿔줘` | 같은 작업 공간·세션으로 이어서 작업 |
| 스레드 | `!stop` | 실행 중인 작업 중단 |

파일 편집은 작업 공간 안에서 자동 허용(`acceptEdits`), Bash 명령이나 작업 공간 밖 접근은 스레드에 승인 버튼이 뜹니다.

## 1단계 체크리스트

- [ ] 요청 → 결과 회신
- [ ] 같은 스레드에서 맥락 유지
- [ ] 태그 유무로 job 폴더 / worktree 분기
- [ ] 연달아 요청 시 대기열 안내 후 순서대로 처리
- [ ] Bash 실행 시 승인 버튼 → 허용/거부 반영
- [ ] `!stop`, 타임아웃으로 중단

## 아직 안 한 것 (다음 단계)

- worktree 작업 후 커밋·push·draft PR, 작업 공간 정리
- launchd 상시 구동
- 다른 봇 메시지 처리(멘션 필터, 턴 제한) → 2단계
