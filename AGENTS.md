# JeonbukCalendar 작업 지침

이 문서는 사람과 AI 작업자가 현재 구조를 빠르게 이해하고, 기존 일정과 Google Calendar 데이터를 훼손하지 않으면서 작업하기 위한 저장소 기준 문서다. `README.md`는 사용자용 설치·운영 안내이고, 이 문서는 구현·검증·배포 시 지켜야 할 작업 계약이다.

## 프로젝트 목적과 기준 상태

- 전북현대의 공식 경기 일정을 `jeonbuk.ics`에서 관리하고 Google Calendar의 `전북현대` 캘린더로 동기화한다.
- 기본 브랜치는 `main`, 원격 저장소는 `aassder95/JeonbukCalendar`다.
- Raw ICS 원본은 `https://raw.githubusercontent.com/aassder95/JeonbukCalendar/main/jeonbuk.ics`다.
- 시간대는 모든 계층에서 `Asia/Seoul`을 기준으로 한다.
- 저장소의 `apps-script/Code.gs`와 `apps-script/appsscript.json`이 Apps Script 소스의 기준이다. 다만 Git push만으로 Apps Script 배포가 갱신되지는 않는다.
- 2026-08-27 기준, 동일 일정은 `unchanged`로 집계하고 변경 일정은 관리 대상 필드만 `patch`하며, 미리보기 해시와 대량 삭제 보호를 거쳐 적용한다.

## 먼저 읽을 파일

작업 전 아래 순서로 실제 코드를 읽는다.

1. 이 문서와 `README.md`
2. 일정 변경이면 `jeonbuk.ics`
3. 동기화 로직 변경이면 `apps-script/Code.gs`와 `apps-script/appsscript.json`
4. 로컬 실행 변경이면 `sync-calendar.cmd`, `sync-calendar.ps1`, `package.json`
5. 동기화 로직 변경이면 반드시 `test/code.test.js`

하위 폴더에 별도 `AGENTS.md`가 생기면 해당 폴더 작업에는 더 가까운 문서도 함께 적용한다. 지침이 충돌하면 임의로 선택하지 말고 충돌을 보고한다.

## 구조와 데이터 흐름

```text
jeonbuk.ics (일정 원본)
  -> GitHub main의 Raw URL
  -> Apps Script syncJeonbuk()
  -> Google Calendar API v3
  -> 전북현대 캘린더의 관리 일정

sync-calendar.cmd
  -> sync-calendar.ps1
  -> previewJeonbuk
  -> 동일 ICS 해시로 applyJeonbuk
  -> created / updated / unchanged / deleted / sourceVersion / icsHash 결과 검증

calendar.cmd
  -> scripts/calendar.ps1
  -> Validate / Preview / Status / Sync / Deploy 운영 명령
```

주요 파일의 역할은 다음과 같다.

- `jeonbuk.ics`: 일정·대진·경기 결과의 단일 데이터 원본
- `apps-script/Code.gs`: ICS 파싱, UID 검증, 라벨 판정, 생성·수정·무변경·삭제 처리
- `apps-script/appsscript.json`: V8 런타임, 시간대, Calendar 고급 서비스, OAuth 범위, 실행 API 설정
- `sync-calendar.ps1`: 로컬 OAuth 인증을 재사용해 배포된 `syncJeonbuk`를 호출하고 응답 형식을 검증
- `sync-calendar.cmd`: Windows에서 PowerShell 실행 정책을 우회해 위 스크립트를 실행하는 진입점
- `calendar.cmd`: 검증, 미리보기, 상태, 동기화, 배포를 한 진입점에서 실행하는 AI·사용자용 도구
- `scripts/calendar.ps1`: 로컬 검증, 배포 버전 비교, 명시적 Apps Script 배포를 담당하는 운영 스크립트
- `sync-log.txt`: `sync-calendar.ps1` 실행마다 시각과 결과(성공 시 건수, 실패 시 오류 메시지)를 한 줄씩 append하는 로컬 전용 실행 이력. 저장소 루트에 실행 시 자동 생성되며 `.gitignore`에 포함되어 커밋되지 않는다. 이 파일 기록 실패는 보조 기능 실패일 뿐이므로 실제 동기화 성공 여부나 스크립트 종료 코드에 영향을 주면 안 된다.
- `test/code.test.js`: Node VM에서 Apps Script의 순수 로직과 저장소 ICS를 검증하는 정적 테스트
- `.clasp.json.example`: 비밀값이 없는 로컬 설정 예시
- `docs/`: OAuth 동의 화면에 사용하는 공개 안내·개인정보 문서

## 일정 데이터 작업 규칙

- 전북현대가 참가하는 K리그, 코리아컵, 슈퍼컵, ACLE와 직접 관련된 공식 추첨 일정만 관리한다.
- 날짜·시간·대진·결과는 구단, 주최 대회 등 공식 출처로 확인한다. 불확실하면 추정해서 확정하지 않는다.
- 한 경기의 영속 식별자는 `UID`다. 일정, 상대, 장소, 시간, 결과가 바뀌어도 기존 `UID`를 유지한다.
- 기존 경기의 결과 반영은 원칙적으로 `SUMMARY`만 바꾸고 `UID`, `DTSTART`, `DTEND`, `LOCATION`은 보존한다. 공식 정정으로 해당 값 자체가 바뀐 경우에만 함께 수정한다.
- 종료 경기는 `[대회/라운드] 홈팀 2-1 원정팀` 형식을 사용한다. 승부차기는 정규·연장 스코어와 승부차기 결과를 구분해 적는다.
- 일정 미확정 상태는 종일 일정 또는 `추첨 후 결정`로 표현하고, 공식 발표 후 같은 `UID`를 갱신한다.
- 탈락 시 실제 치른 경기까지는 기록으로 남기고, 탈락 이후의 미래 라운드만 제거한다.
- ICS에서 관리 일정을 제거하면 다음 동기화 때 Google Calendar에서도 삭제된다. 삭제 범위를 반드시 diff로 확인한다.
- `DESCRIPTION`에 확인일, 작업 메모, 출처 관리 문구를 넣지 않는다.

## 동기화 구현 계약

- `syncJeonbuk()`와 `applyJeonbuk()`는 `{ created, updated, unchanged, deleted, icsHash, sourceVersion }` 결과를 반환하며 건수는 음이 아닌 정수여야 한다.
- ICS 파싱 결과가 0건이면 전체 삭제 위험을 막기 위해 즉시 실패해야 한다.
- 중복되거나 빈 `UID`는 동기화 전에 실패해야 한다.
- 동기화가 만든 일정만 `extendedProperties.private.jeonbukCalendarManaged=true` 표식으로 관리한다. 표식이 없는 사용자·회사 일정은 수정하거나 삭제하지 않는다.
- 기존 일정 비교 대상은 `summary`, `location`, `description`, `start`, `end`, `eventLabelId`, 관리 표식이다. 서버 전용 필드인 `id`, `etag`, `updated` 등은 비교하지 않는다.
- `location`과 `description`의 `null`, `undefined`, 빈 문자열은 같은 값으로 취급한다.
- 종일 일정은 `date`를 그대로 비교하고, 시간 일정은 RFC3339 절대 시각으로 비교한다. `Asia/Seoul` 오프셋 없는 로컬 시각과 같은 UTC 시각을 동일하게 처리해야 한다.
- 기존 값이 같으면 Calendar 쓰기 API를 호출하지 않고 `unchanged`를 증가시킨다.
- 신규 일정은 `Calendar.Events.import()`, 변경 일정은 동기화 소유 필드만 `Calendar.Events.patch()`, 사라진 관리 일정은 `Calendar.Events.remove()`를 사용한다.
- 모든 일정의 날짜, 시간대, 라벨, UID를 검증하고 전체 변경 계획을 만든 뒤 첫 쓰기를 시작한다.
- `previewJeonbuk()`는 변경 건수, 대상 UID, ICS SHA-256, 소스 버전, 대량 삭제 승인 필요 여부를 반환한다.
- `applyJeonbuk(expectedIcsHash, allowLargeDelete)`는 적용 직전 ICS 해시를 다시 확인한다.
- 삭제가 5건을 넘거나 기존 관리 일정의 20%를 넘으면 명시적인 대량 삭제 승인이 필요하다.
- stale 삭제 동작을 다른 최적화와 묶어 변경하지 않는다.
- 라벨 이름을 바꾸면 Google Calendar의 실제 라벨, `CONFIG.labelNames`, `findLabelName`, 테스트를 함께 확인한다.
- OAuth 범위는 소유 캘린더 이벤트 편집, 캘린더 목록 읽기, 캘린더 속성 읽기로 제한한다. 대상 캘린더 소유권이 달라지면 범위를 임의 확대하지 말고 운영 계약을 재검토한다.

## 변경 범위와 보안 경계

- 요청받은 파일과 동작만 변경한다. 일정 데이터 작업에서 동기화 구조를 함께 리팩터링하지 않는다.
- `.clasp.json`, `.clasprc*.json`, `client_secret*.json`, `oauth-client*.json`, OAuth 토큰과 계정 정보는 읽어서 출력하거나 커밋하지 않는다.
- `apps-script/Code.gs` 쓰기가 `Access denied` 또는 `Failed to write file`로 막히면 ACL 변경, 원본 삭제·교체 같은 우회를 하지 않는다. 권한이 있는 세션에서 다시 작업한다.
- Apps Script 배포, 실제 Google Calendar 동기화, 실제 commit/push는 사용자가 명시적으로 요청한 경우에만 수행한다.
- 자동 트리거 설치 함수는 제거되어 있으며 별도 요청 없이 다시 추가하거나 자동 트리거를 설치하지 않는다.
- 배포된 Apps Script API는 저장소 파일이 아니라 배포 버전을 실행한다. 소스 변경 뒤 실제 동기화를 요구받았다면 웹 편집기 반영과 API 실행 파일 새 버전 배포 여부를 따로 확인한다.
- `apps-script/Code.gs`를 변경할 때 `CONFIG.sourceVersion`도 갱신하고 `calendar.cmd Status`로 배포 버전과 비교한다.

## 공식 경기 결과 자동 반영 시 안전 절차

외부 자동화나 AI가 경기 결과를 반영할 때는 다음 순서를 지킨다.

1. 공식 1차 출처에서 종료된 경기와 최종 스코어를 확인한다.
2. 수정 전에 비대화식 Git push 가능 여부를 dry-run으로 확인한다.
3. dry-run, 네트워크, 인증이 실패하면 파일 수정·commit·push·캘린더 동기화를 모두 중단한다.
4. 대상 경기의 기존 `UID`와 날짜·장소를 확인하고 필요한 ICS 필드만 수정한다.
5. 테스트, UID 중복, diff, 변경 파일 범위를 확인한다.
6. 명시적으로 승인된 경우에만 commit/push한 뒤 `sync-calendar.cmd`를 실행한다.
7. 공식 결과가 없거나 이미 반영되어 있으면 아무것도 변경하지 않는다.

Windows 비대화식 사전검사에서는 필요에 따라 실행 범위에만 `git -c safe.directory=C:/my/JeonbukCalendar`를 적용하고 `GCM_INTERACTIVE=Never`, `GIT_TERMINAL_PROMPT=0`을 사용한다. 전역 Git 보안 설정을 임의로 바꾸지 않는다.

## 검증 명령

PowerShell 실행 정책이 `npm.ps1`을 차단할 수 있으므로 Windows에서는 아래 명령을 우선 사용한다.

```powershell
npm.cmd test
calendar.cmd Validate
git diff --check
git status --short -uall
```

필요하면 Apps Script 문법을 표준 입력으로 Node에 전달해 확인한다. `node --check apps-script/Code.gs`는 `.gs` 확장자를 직접 처리하지 못할 수 있다.

검증 결과는 다음을 구분해 보고한다.

- `npm.cmd test`: 로컬 순수 로직과 저장소 ICS 검증
- `git diff --check`: 공백 오류 검증
- Apps Script 배포: 웹 편집기 반영과 새 실행 API 버전 생성 여부
- 실제 동기화: 사용자 Google Calendar에 대한 외부 변경
- 브라우저 확인: Google Calendar UI에서 최종 일정 확인

로컬 테스트 통과만으로 배포 또는 실제 동기화 성공을 주장하지 않는다.

## Git 작업과 완료 체크리스트

- 더러운 working tree에서는 기존 변경을 보존하고 요청 범위만 다룬다.
- 새 파일까지 포함하려면 `git status --short -uall`로 범위를 확인한다.
- commit/push 요청이 있을 때만 stage하고, 직전에 아래를 확인한다.

```powershell
git diff --cached --name-only
git diff --cached --stat
git diff --cached --check
```

완료 전에 다음을 확인한다.

- 변경 파일이 요청 범위 안에 있는가
- 기존 경기의 `UID`가 보존되었는가
- ICS에 빈 UID나 중복 UID가 없는가
- 관리 표식 없는 일정을 건드리지 않는가
- `created`, `updated`, `unchanged`, `deleted` 계약과 테스트가 일치하는가
- 비밀 파일과 인증 정보가 diff에 없는가
- 저장소 소스 변경과 Apps Script 배포·실제 동기화를 구분해 보고했는가
