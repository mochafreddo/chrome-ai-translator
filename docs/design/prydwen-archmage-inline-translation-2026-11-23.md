# Prydwen 아크메이지 가이드 Inline Translation 설계 인터뷰

2026-11-23에 보고된 [아크메이지 가이드](https://www.prydwen.gg/sword-x-staff/guides/build-guide-archmage)의 번역 문제를 조사했다. 기준은 `fcff98ac1673a38e8a7bd98a7605d3d1259eb680`이다.

## 관측

- 진단에서 28개 Semantic Block은 `local_preflight`의 `unsupported_descendant / IMG`로 거부됐고 모델 요청은 없었다. 공개 페이지의 문단 28개에서 `alt`가 있는 이미지 38개를 확인했다. 각 아이콘은 `IMG` 하나를 담은 `SPAN`에 있고, 그 형제 `SPAN`은 `alt`와 같은 표시 이름만 담는다. 두 `SPAN`의 공통 부모는 `inline-flex`인 `SPAN`이다. 그중 문단 16개는 아이콘과 이름, 공백 또는 `|` 구분자로만 구성된다. 관측한 구조를 모사한 로컬 DOM에서 설명문이 있는 문단과 이름만 있는 문단 모두 당시 codec이 `IMG`에서 거부했다. [조사 기준의 이미지 판정](https://github.com/mochafreddo/chrome-ai-translator/blob/fcff98ac1673a38e8a7bd98a7605d3d1259eb680/extension/inline-block.js#L390-L437)
- Partial Translation 1개는 교정 한 번 후에도 원문과 연속된 영어 세 단어가 한 곳에서 겹쳤다. 가이드 소개 문단의 원문 길이와 단어 수가 진단의 83자, 16단어와 일치했다. 그 문단을 한국어로 번역하고 게임 제목 `Sword x Staff`만 영문으로 남긴 고정 응답에서 경고를 재현했다. 게임 제목도 한글로 표기한 대조 응답에서는 경고가 없었다. 당시 실제 모델 응답은 확인하지 못했다. [영어 잔류 판정](../../extension/inline-model-execution.js#L151)

## 확정한 설계

- Q1. 공개 페이지에서 확인한 아이콘과 이름의 묶음을 우선 지원한다. 원래 이미지 노드와 `alt`를 유지하고, 번역에 따라 어순이 바뀌어도 아이콘이 자기 이름과 함께 이동해야 한다.
- Q2. 자동 교정은 블록당 한 번으로 유지한다. Partial Translation의 수정 범위는 해당 원문과 실제 번역문을 대조한 뒤 결정한다.
- Q3. 보고된 Prydwen 가이드에서 관측한 구조에 한해 아이콘과 표시 이름 전체를 하나의 Placeholder Token으로 보존한다. 표시 이름은 원문으로 유지하고 같은 문단의 설명은 번역한다. 승인된 묶음과 공백 또는 `|`만 있는 문단은 모델 요청과 실패 표시 없이 건너뛴다.

문단에는 페이지가 소유한 이미지, `alt`, 표시 이름과 기존 노드가 유지된다. 적용·캐시 재사용·복원 시 현재 DOM의 소유권과 묶음의 자격을 재확인한다. 본문이 있는 문단이 이름 목록으로 바뀌면 추가 모델 요청 없이 종료할 수 있고, 이후 설명이 추가되면 다시 발견할 수 있다. 이미 보낸 요청의 비용은 Session Budget에 계속 반영된다. [DOM 소유권](../architecture.md#dom-boundaries) · [Session 처리](../../extension/inline-translation-session.js)

## 검증 기준

- 검토 기준은 `fcff98ac1673a38e8a7bd98a7605d3d1259eb680`이다. 공개 검증 접점은 Semantic Block의 직렬화·적용·복원과 Session의 요청 등록·캐시·페이지 변경 처리다.
- 로컬 고정 응답으로 두 스킬의 순서를 뒤집어 아이콘과 이름이 원래 짝으로 이동하는지, `alt`와 노드 동일성이 유지되는지, 원문을 정확히 복원하는지 확인한다. 이름과 구분자만 있는 문단은 모델 요청과 실패 여부를 확인한다. 회귀 검사가 수정 전 코드에서 실패하는지 확인한다.
- 공개 페이지 구조 관측과 로컬 고정 응답 검사는 각각 기록한다. 실제 모델 출력이 필요한 Partial Translation 판정은 원문과 출력 한 쌍을 확보할 때까지 보류한다. [무료 브라우저 검증 범위](../../tests/README.md#unbilled-chrome-checks)
