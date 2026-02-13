# Racegame

## PR 충돌(Conflict) 해결 가이드

현재 이 저장소 환경에서는 Git 원격(`origin`)이 연결되어 있지 않아, GitHub PR 화면의 충돌을 여기서 직접 해소(merge/rebase + push)할 수 없습니다.

아래 명령을 **충돌이 난 PR 브랜치에서 로컬 터미널**로 실행하면 `index.html`, `js/game.js` 충돌을 해결할 수 있습니다.

### 1) PR 브랜치 체크아웃

```bash
git checkout <충돌난-PR-브랜치>
```

### 2) main 최신 반영

```bash
git fetch origin
git merge origin/main
```

> `merge` 대신 `rebase`를 쓰려면 `git rebase origin/main`을 사용해도 됩니다.

### 3) 충돌 파일 해결

이번 케이스에서는 자유주행/오픈월드 변경이 들어간 PR 쪽 내용을 우선 유지하는 것이 안전합니다.

```bash
git checkout --ours index.html js/game.js
git add index.html js/game.js
git commit -m "Resolve conflicts in index.html and js/game.js"
```

### 4) 원격 반영

```bash
git push origin <충돌난-PR-브랜치>
```

푸시가 완료되면 GitHub PR의 "병합할 수 없음" 상태가 해소됩니다.

---

## 빠른 점검 명령

충돌 마커가 남았는지 확인:

```bash
rg -n "^(<<<<<<<|=======|>>>>>>>)" index.html js/game.js
```

문법 체크:

```bash
node --check js/game.js
```
