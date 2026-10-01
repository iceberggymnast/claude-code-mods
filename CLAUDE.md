# claude-code-mods

공개 저장소다. 파일 내용, 커밋 메시지, 작성자 정보가 모두 공개된다.

## 공개 점검

커밋하기 직전과 push하기 직전에 아래 명령을 실행한다. 점검은 매치가 0건이거나, 남은 매치 하나하나를 공개해도 되는 이유와 함께 사용자에게 보고했을 때 끝난다. 매치를 고친 뒤에는 같은 명령을 다시 실행해 0건을 확인한다.

**커밋 전**: 이번에 추가되는 줄

```bash
git diff --cached -U0 | grep '^+' | grep -n -i -E -f .private-patterns -e "$PUBLIC_CHECK"
```

**push 전**: 모든 커밋의 파일, 커밋 메시지, 작성자

```bash
git grep -n -I -i -E -f .private-patterns -e "$PUBLIC_CHECK" $(git rev-list --all)
git log --all --format=%B | grep -n -i -E -f .private-patterns -e "$PUBLIC_CHECK"
git log --all --format='%an <%ae>' | sort -u
```

작성자 이메일은 GitHub noreply 주소(`<id>+<login>@users.noreply.github.com`)여야 한다. 이 저장소의 `git config user.email`에 설정되어 있다.

`$PUBLIC_CHECK`는 누구에게나 해당하는 패턴이다. 명령 앞에서 정의한다.

```bash
PUBLIC_CHECK='[A-Za-z]:[\\/]Users[\\/]|/Users/|/home/|@(gmail|naver|daum|kakao)\.|sk-ant-|access_token|refresh_token|bearer |password|\.credentials|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-'
```

## 찾는 대상

- **비밀**: API 키, 토큰, 자격 증명 파일의 내용
- **이 PC를 특정하는 것**: 사용자 홈 경로, 로컬 저장소 경로, 계정별 설정 디렉터리 이름
- **개인 식별 정보**: 실명, 개인 이메일
- **비공개 작업의 흔적**: 비공개 프로젝트·저장소 이름, 개인 스크립트·훅 파일명, 노트 볼트 경로와 폴더명
- **개발 중 진단 출력**: 응답 usage 샘플, 세션 기록 조각, 세션 ID

공개 코드나 문서에서 개인 환경을 가리켜야 하면 일반 표현으로 쓴다: `~/.claude`, `<repo>`, "저장소 루트의 STATE.md".

## .private-patterns

개인 문자열 목록이다. 한 줄에 정규식 하나를 쓴다. 이 파일 자체가 개인 정보이므로 gitignore 대상이고, 이 문서에는 내용을 옮겨 적지 않는다. 파일이 없으면 점검을 진행하지 말고 사용자에게 만들어 달라고 요청한다. 실명과 계정명은 `$PUBLIC_CHECK`만으로는 잡히지 않는다.

## 구조

- `.claude-plugin/marketplace.json`: 이 저장소를 마켓플레이스로 등록할 때 읽는 목록
- `plugins/<이름>/`: 모드 하나. 엔진이 로드하면서 만드는 `.claude-plugin/types/`와 `tsconfig.json`은 커밋하지 않는다
- 바꾼 모드는 `claude plugin validate plugins/<이름>`으로 검사한다
