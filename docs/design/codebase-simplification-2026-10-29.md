# 코드베이스 단순화 설계 인터뷰

이 문서는 기준 커밋 `154175a262fb30ed1b7d5a2bae04c4edc5fd1089`의 전체 코드베이스 단순화 검토와 후속 설계 인터뷰를 기록한다. 2026-10-29에 사용자가 Q1부터 Q4까지의 추천안을 모두 수락하고, Q5의 최종 작업 범위·공개 테스트 경계·검토 기준 제안에 이어 `implement`를 요청해 해당 범위의 구현을 승인했다.

## 근거와 한계

검토는 런타임 소스, 호출 관계, 관련 테스트와 기존 설계·ADR에 근거한다. 테스트와 브라우저를 실행하지 않았으며 성능 개선량도 측정하지 않았다. 아래 내용은 동작 보존을 목표로 한 유지보수 개선안이며, 구현·검증 결과나 기능 결함 보고가 아니다.

## 합의한 결정

### Q1: DOM 복원 검사의 공통 부분 공유

[heading-permalink](../../tests/integration/heading-permalink.test.mjs), [data-as-paragraph](../../tests/integration/data-as-paragraph.test.mjs), [ai-hero-responsive-labels](../../tests/integration/ai-hero-responsive-labels.test.mjs), [github-skill-page](../../tests/integration/github-skill-page.test.mjs), [inline-button](../../tests/integration/inline-button.test.mjs)의 여섯 구현에서 반복하는 DOM 캡처·비교만 테스트 전용 함수로 공유한다. 캡처 대상은 노드 참조, `nodeValue`, 자식 수와 자식 순서다. 원래 자식 목록을 사용하는 버튼 순서 변경 판정과, 적용·복원이 서로 다른 페이지 평가 호출에서 실행되는 경로도 유지한다.

HTML·속성·포커스·클릭·페이지 소유 상태 검사는 각 시나리오에 남긴다. 제품 codec의 스냅샷 구현을 재사용하지 않아 검사 기준의 독립성을 유지한다. 기존 함수 직렬화와 `page.evaluate()` 경계를 활용하며 새 프레임워크는 추가하지 않는다.

### Q2: 사이드 패널의 중복 오류 상태 제거

[sidepanel.js](../../extension/sidepanel.js)의 `invocationError`는 렌더링 시 기존 `readInlineTranslationError(state)`로 계산한다. 선택한 탭의 오류 소유권을 중복 추적하는 `controlErrorTabId`와 관련 대입·비교는 제거한다.

탭 변경 시 오류 초기화와 비동기 응답의 `selection`·`inlineControl` 검사는 유지한다. 오류 표시, 폴링 중 오류 유지, 페이지 접근 복구, 탭 왕복, 늦은 응답 차단의 기존 동작을 보존한다. worker epoch·본문 버전·번역 수명주기는 변경하지 않는다.

### Q3: 기존 UUID 검증식 재사용

[inline-diagnostics-controller.js](../../extension/inline-diagnostics-controller.js)의 상관관계 항목 정규화는 이미 가져온 [프로토콜](../../extension/inline-diagnostics-protocol.js)의 `uuidV4Pattern`을 사용한다. 현재 두 정규식은 같고 공통 패턴에 `g`·`y` 플래그가 없어 반복 호출의 정규식 상태 차이가 없다. 새 함수나 설정은 추가하지 않는다.

### Q4: 큐 초기화의 무효 호출 삭제

[inline-translation-session.js](../../extension/inline-translation-session.js)의 `resetQueue()`는 `retryOf`가 참인 레코드를 먼저 보존하고 다음 레코드로 넘어간다. 그 뒤의 `clearRetrySupersession()` 호출은 첫 조건에서 항상 반환하므로 해당 호출 한 줄만 삭제한다. 실제 재시도 해제를 수행하는 `stopOperation()`의 호출과 큐 초기화 시 재시도 보존 정책은 유지한다.

## 확정한 범위와 검증 기준

구현과 검토는 다음 범위를 따른다.

| 저장소 | 작업 범위 | 공개 테스트 경계 | 검토 기준 |
| --- | --- | --- | --- |
| chrome-ai-translator | Q1의 테스트 전용 공유 함수와 다섯 호출 파일, Q2의 패널 오류 상태, Q3의 UUID 검증식, Q4의 무효 호출, 필요한 기존 테스트 보완, 이 설계 기록과 문서 색인 | DOM 캡처·비교 결과, 패널 컨트롤러의 메시지·렌더 결과, 진단 컨트롤러의 공개 동작, Session의 큐 초기화·재시도·Stop 동작 | `154175a262fb30ed1b7d5a2bae04c4edc5fd1089` 대비 합의한 변경과 작업 트리 |

공유 DOM 검사에는 텍스트 노드 교체, 자식 순서 변경, 텍스트 변경을 각각 거절하는 최소 검사를 둔다. 제품 codec과 같은 구현을 호출해 정답을 만들지 않는다. 패널과 인라인 경로는 기존 공개 인터페이스 테스트를 보완하며 내부 변수의 존재나 소스 문구를 검사하지 않는다.

구현 후에는 소스 검토를 마치고 입력을 고정한 뒤 `npm run verify:local`과 영향을 받는 다섯 비과금 브라우저 검사를 실행한다. 다섯 검사는 Q1에 연결된 파일의 `test:integration:heading-permalink`, `test:integration:data-as-paragraph`, `test:integration:ai-hero-responsive-labels`, `test:integration:github-skill-page`, `test:integration:inline-button`이다. 각 검사의 현재 선행 조건·공개 페이지 접근·fixture 범위는 실행 전에 확인한다. 새 검사가 방어하는 실패를 실제로 거절하는지도 같은 환경의 대조군으로 확인한다. 구현 요청에 명시된 절차에 따라 검토·검증 후 현재 브랜치에 커밋한다. 과금 모델 검사, 자격 증명 접근, 푸시·배포는 포함하지 않는다.

## 문서화와 제외 범위

새 도메인 개념은 없으므로 용어집은 변경하지 않는다. 네 변경은 국소적이고 되돌리기 쉬워 새 ADR을 만들지 않는다. 채택 이유와 검증 경계는 이 설계 기록과 문서 색인에 남긴다.

문서 앵커 캐시는 [기존 보류 결정](codebase-simplification-2026-10-26.md#q4-문서-앵커-캐시-보류)을 유지한다. 사용처가 없는 `cacheEnabled`·`cacheTtlDays` 제거는 저장값과 공개 설정 형태에 영향을 줄 수 있어 포함하지 않는다. DOM 소유권 검사 통합과 서로 다른 비용 계산 계약의 통합도 포함하지 않는다.
