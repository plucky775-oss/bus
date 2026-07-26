# 우리 버스 알림

호계 e편한세상에서 평촌고·평촌학원가 방향으로 가는 버스를 찾아 실시간 위치를 표시하고, 설정한 시간대에 탑승 정류장 **3정거장 전**이 되면 푸시 알림을 보내는 설치형 PWA입니다.

## 구현 기능

- 경기도 공식 버스 API 정류장 검색
- 출발·도착 정류장을 함께 지나는 직행 노선 자동 탐색
- 노선 경유 정류장과 운행 중 차량 지도 표시
- 첫 번째·두 번째 버스 도착 예정시간 및 남은 정류장 수
- 요일·시간대·1~5정거장 전 알림 설정
- 앱 실행 중 30초 간격 자동 갱신 및 소리·진동 알림
- Firebase Cloud Functions 1분 감시 + FCM 백그라운드 푸시
- iPhone·Android 홈 화면 설치 지원

## 1. 공공데이터 API 키

공공데이터포털에서 아래 4개 API의 활용신청을 합니다. 개발계정은 자동승인됩니다.

1. 경기도_버스노선 조회
2. 경기도_정류소 조회
3. 경기도_버스위치정보 조회
4. 경기도_버스도착정보 조회

네 API를 모두 활용신청해야 합니다. **버스위치정보 조회만 승인받으면 정류장 검색 단계에서 403 오류가 발생합니다.** 같은 공공데이터포털 일반 인증키를 사용하며, Vercel에는 Encoding 키와 Decoding 키 중 어느 쪽을 넣어도 앱이 자동으로 정규화합니다.

```env
GBIS_SERVICE_KEY=발급받은_일반인증키
```


### 403 오류가 날 때

앱 첫 화면의 정류장 검색은 `경기도_정류소 조회` API를 사용합니다. 공공데이터포털 개발계정 상세보기에 `경기도_버스위치정보 조회`만 승인되어 있다면 파일을 다시 배포해도 403은 없어지지 않습니다. 아래 네 항목을 각각 활용신청한 뒤 Vercel에서 재배포하세요.

- 경기도_정류소 조회
- 경기도_버스노선 조회
- 경기도_버스위치정보 조회
- 경기도_버스도착정보 조회

수정 버전은 403 응답 시 어떤 API 승인이 빠졌는지 화면에 직접 표시합니다.

## 2. Firebase 설정

Firebase 콘솔에서 프로젝트를 만들고 다음 기능을 켭니다.

- Authentication → 익명 로그인 사용
- Firestore Database 생성
- Cloud Messaging → Web Push 인증서(VAPID 키) 생성
- 웹 앱 추가 후 Firebase 설정값 확인

Vercel 환경변수:

```env
FIREBASE_API_KEY=
FIREBASE_AUTH_DOMAIN=
FIREBASE_PROJECT_ID=
FIREBASE_STORAGE_BUCKET=
FIREBASE_MESSAGING_SENDER_ID=
FIREBASE_APP_ID=
FIREBASE_VAPID_KEY=
```

## 3. Vercel 배포

프로젝트 폴더를 GitHub에 올린 뒤 Vercel에서 Import합니다.

- Framework Preset: Other
- Build Command: 비워 둠
- Output Directory: 비워 둠
- 위 환경변수 8개 등록

## 4. Firebase Functions 배포

백그라운드 감시는 Cloud Scheduler를 쓰므로 Firebase Blaze 요금제가 필요합니다. 호출량은 알림 수와 감시 시간에 따라 달라집니다.

```bash
npm install -g firebase-tools
firebase login
cp .firebaserc.example .firebaserc
# .firebaserc의 프로젝트 ID 수정
cd functions
npm install
cd ..
firebase functions:secrets:set GBIS_SERVICE_KEY
firebase deploy --only functions,firestore:rules
```

Functions 비밀값에도 공공데이터 일반 인증키를 입력합니다.

## 5. 휴대폰 설치

### iPhone/iPad

Safari에서 배포 주소 열기 → 공유 → **홈 화면에 추가** → 설치된 앱을 열어 알림 허용.

### Android

Chrome에서 배포 주소 열기 → 메뉴 → **앱 설치** 또는 **홈 화면에 추가** → 알림 허용.

## 알림 동작 원리

경기도 도착정보의 `locationNo1` 값은 첫 번째 차량이 탑승 정류장으로부터 몇 정류장 전에 있는지를 뜻합니다. 서버가 매분 확인해 설정값 이하가 되는 순간 한 번 알리고, 해당 버스가 지나가 다음 버스가 멀어지면 다시 알림 대기 상태로 전환합니다.

## 주의사항

- 도착시간과 위치는 교통상황·운행정보 지연에 따라 실제와 차이가 날 수 있습니다.
- 휴대폰 무음 또는 방해금지 모드에서는 알림 소리가 제한될 수 있습니다.
- 앱 화면의 실시간 위치는 30초, 백그라운드 푸시는 1분 단위라 3정거장 진입 후 최대 약 1분 뒤 알릴 수 있습니다.
- 개발계정 API 호출량이 부족하면 공공데이터포털에서 운영계정 트래픽 증량을 신청해야 합니다.
