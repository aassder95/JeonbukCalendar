# Jeonbuk Calendar

전북현대의 경기 일정을 Google Calendar에 동기화하기 위한 ICS 저장소다.

## 구조

- `jeonbuk.ics`: 일정 원본. GitHub의 같은 파일을 갱신하고 Apps Script를 실행한다.
- `apps-script/Code.gs`: Raw ICS를 읽어 Google Calendar의 `전북현대` 캘린더에 일정을 추가, 수정, 삭제하는 Apps Script 원본이다.
- `apps-script/appsscript.json`: 시간대와 Google Calendar API v3 고급 서비스 설정이다.
- `sync-calendar.cmd`: PowerShell 동기화 스크립트를 실행하고 성공 또는 실패 종료 코드를 반환한다.
- `sync-calendar.ps1`: Apps Script API로 `syncJeonbuk`를 호출하고 추가, 수정, 변경 없음, 삭제 건수를 검증한다.
- `.clasp.json.example`: 로컬 전용 `.clasp.json` 설정 예시다.
- Raw ICS URL: `https://raw.githubusercontent.com/aassder95/JeonbukCalendar/main/jeonbuk.ics`

이 저장소의 `apps-script/Code.gs`를 Apps Script 웹 편집기의 `Code.gs`와 동일하게 유지한다. 일정 데이터만 바꿀 때는 `jeonbuk.ics`만 수정하면 된다.

## 동기화 방식

### 평소 사용 순서

1. `jeonbuk.ics`를 최신 일정으로 수정한다.
2. 변경 내용을 GitHub `main` 브랜치에 푸시한다.
3. 푸시가 끝나면 저장소 루트의 `sync-calendar.cmd`를 실행한다.
4. 콘솔에 `전북현대 일정 동기화 완료`와 추가, 수정, 변경 없음, 삭제 건수가 표시되는지 확인한다.
5. Google Calendar를 새로고침하여 변경된 일정을 확인한다.

> GitHub에 푸시하는 것만으로 Google Calendar가 변경되지는 않는다. 푸시 후 반드시 `sync-calendar.cmd`를 더블클릭해야 캘린더에 반영된다.

### 명령줄 동기화 최초 설정

1. 저장소에서 `npm ci`를 실행한다.
2. 개인 Google 계정의 Apps Script 프로젝트 `전북현대 일정 동기화`를 연다.
3. 저장소의 `apps-script/Code.gs`와 `apps-script/appsscript.json`을 웹 편집기의 코드와 매니페스트에 반영하고 저장한다.
4. Apps Script 프로젝트를 표준 Google Cloud 프로젝트에 연결하고 해당 프로젝트에서 Google Apps Script API를 활성화한다.
5. Google Cloud에서 데스크톱 앱 유형 OAuth 클라이언트를 만들고 JSON 파일을 내려받는다.
6. `.clasp.json.example`을 `.clasp.json`으로 복사하고 Apps Script ID와 Google Cloud 프로젝트 ID를 입력한다.
7. 아래 명령으로 프로젝트 권한과 clasp 기본 권한을 한 번 승인한다.

   ```powershell
   .\node_modules\.bin\clasp.cmd --project .\.clasp.json login --creds .\client_secret.json --use-project-scopes --include-clasp-scopes
   ```

8. Apps Script 편집기에서 `배포` → `새 배포` → `API 실행 파일`을 선택하고 액세스 권한을 `나만`으로 배포한다.
9. `sync-calendar.cmd`를 실행해 추가, 수정, 변경 없음, 삭제 건수가 출력되는지 확인한다.

OAuth 클라이언트 JSON, `.clasp.json`, clasp 인증 정보는 Git에 커밋하지 않는다. 예약 실행은 최초 로그인에서 저장된 OAuth 갱신 토큰을 재사용하므로 브라우저 선택이나 로그인 입력을 요구하지 않는다.

Apps Script API는 배포된 버전을 실행한다. `apps-script/Code.gs` 또는 `apps-script/appsscript.json`을 변경했으면 웹 편집기에 반영하고 API 실행 파일을 새 버전으로 갱신한 뒤 사용한다. GitHub에 푸시하는 것만으로 Apps Script 프로젝트 코드가 자동 배포되지는 않는다.

명령줄 실행을 사용할 수 없는 비상 상황에는 Apps Script 편집기에서 `syncJeonbuk`를 직접 실행한다. 매일 실행하는 Apps Script 자동 트리거는 설치하지 않는다.

### 로컬 검증

Apps Script 코드를 변경한 뒤 아래 명령으로 ICS 파싱, 날짜 변환, UID 검증, 일정 비교, 대회 라벨 판정 테스트를 실행한다.

```powershell
npm test
```

## 업데이트 운영 규칙

일정 업데이트 요청을 받으면 전북현대가 출전하는 대회만 아래 기준으로 관리한다.

- 대상 대회는 `K리그`, `코리아컵`, `슈퍼컵`, `아시아챔피언스리그 엘리트(ACLE)`다.
- 전북현대의 대진에 영향을 주는 공식 조 추첨 및 토너먼트 대진 추첨 일정도 포함한다.
- 공식 발표로 날짜와 시간이 확인된 일정만 확정 시간으로 등록한다. 날짜만 발표된 일정은 종일 일정으로 등록하고 시간이 발표되면 같은 `UID`로 갱신한다.
- K리그 다음 시즌 공식 일정이 발표되면 전북현대의 해당 시즌 전체 일정을 추가한다.
- 코리아컵과 ACLE 토너먼트에서 전북현대가 진출 중이면 발표된 향후 라운드 일정을 결승까지 미리 등록한다. 상대가 정해지지 않았으면 제목에 `추첨 후 결정`을 사용한다.
- 추첨 결과가 발표되면 기존 `UID`를 유지하면서 상대, 홈과 원정, 날짜, 시간을 수정한다.
- 전북현대가 탈락하면 탈락 경기까지는 남기고 이후 라운드의 미래 일정은 ICS에서 제거한다. 다음 동기화 때 해당 Google Calendar 일정도 삭제된다.
- 종료된 경기는 공식 결과를 확인해 제목을 `[대회/라운드] 홈팀 2-1 원정팀` 형식으로 갱신한다. 승부차기가 있으면 정규 및 연장 종료 스코어와 승부차기 결과를 함께 표기한다.
- 연기, 취소, 시간 변경은 새 일정을 만들지 않고 기존 `UID`를 유지해 수정한다.
- 완료된 경기와 전북현대가 실제로 치른 라운드는 기록으로 계속 남긴다.

## 일정 식별과 갱신

- 각 일정은 ICS의 `UID`로 식별한다.
- 기존 `UID`가 있으면 제목, 장소, 설명, 시작 및 종료 시간, 라벨, 관리 표식을 비교하고 달라진 경우에만 수정한다.
- 새로운 `UID`이면 새 일정을 추가한다.
- 기존 일정의 `UID`를 바꾸면 중복 일정이 생길 수 있으므로 같은 경기는 기존 `UID`를 유지한다.
- ICS에 `DESCRIPTION`이 없으면 기존 Google Calendar 메모를 삭제한다.
- 동기화가 만든 일정에는 비공개 관리 표식을 저장한다.
- 관리 표식이 있는 일정이 ICS에서 사라지면 Google Calendar에서도 자동 삭제한다. 관리 표식이 없는 회사 일정이나 직접 만든 일정은 삭제하지 않는다.
- 빈 ICS나 읽기 오류로 전체 일정이 잘못 삭제되지 않도록, 읽은 일정이 0건이면 동기화를 중단한다.

## 라벨

Google Calendar의 `전북현대` 캘린더에 아래 이벤트 라벨이 미리 존재해야 한다.

- `K리그`
- `코리아컵`
- `슈퍼컵`
- `아시아챔피언스리그`

Apps Script가 일정 제목과 설명의 대회명을 확인하여 이벤트별 라벨을 자동 지정한다. 라벨 이름을 Google Calendar에서 변경하면 Apps Script의 `CONFIG.labelNames`와 `findLabelName`도 함께 수정해야 한다.

## ICS 작성 규칙

- 시간대는 `Asia/Seoul` 기준으로 관리한다.
- `SUMMARY`에는 대회명과 양 팀이 드러나게 작성한다.
- `LOCATION`은 경기장명 대신 `전북현대 홈` 또는 상대 팀 원정처럼 간단히 작성한다.
- 확정되지 않은 일정은 임의로 확정하지 않는다.
- 확인일이나 출처 설명 같은 관리용 메모는 `DESCRIPTION`에 넣지 않는다.

## 주요 설정

- 대상 캘린더 이름: `전북현대`
- Apps Script 고급 서비스: Google Calendar API v3 (`Calendar`)
- Apps Script 시간대: `Asia/Seoul`
- 자동 트리거: 사용하지 않음
- 로컬 실행: `sync-calendar.cmd` → `sync-calendar.ps1` → Apps Script API `syncJeonbuk()`
