# タスク: OpenMausBotのブラウザ通知設定およびPR作成

## 概要
サーバーに接続するブラウザ（WindowsおよびAndroid）上で、新しいメッセージが到着した際に通知を送信する設定を追加し、milind-soni/OpenMausBot に対するPull Requestを作成・送信する。

## タスクリスト
- [x] 要求仕様およびコードベースの調査 <!-- id: 0 -->
  - [x] notify.ts, notification-preferences.ts, store.tsx の実装確認 <!-- id: 1 -->
  - [x] Android/WindowsブラウザでのNotification API仕様（Service Worker / showNotification）の確認 <!-- id: 2 -->
- [x] 実装計画 (implementation_plan.md) の作成 <!-- id: 3 -->
- [x] Service Worker および Web通知基盤の実装 <!-- id: 4 -->
  - [x] Service Worker スクリプト (public/sw.js) の作成と登録処理 <!-- id: 5 -->
  - [x] notify.ts に Service Worker 経由の showNotification サポートとフォールバック実装 <!-- id: 6 -->
  - [x] メッセージ到着時の通知設定 (messageNotificationsEnabled / setMessageNotifications) の追加 <!-- id: 7 -->
  - [x] store.tsx にてボットからのメッセージ受信時に通知を発行するロジック追加 <!-- id: 8 -->
- [x] UI / 設定画面の実装 <!-- id: 9 -->
  - [x] SettingsModal.tsx に「ブラウザ通知」設定（パーミッション要求ボタン、メッセージ通知トグル）の追加 <!-- id: 10 -->
  - [x] locales (en.json, ja.json, source-hashes.json) に多言語文言の追加 <!-- id: 11 -->
- [x] テストおよびビルド検証 <!-- id: 12 -->
  - [x] notify.test.ts, notification-preferences.test.ts の更新およびテスト実行 <!-- id: 13 -->
  - [x] クライアントのビルド (pnpm build / typecheck / lint) 検証 <!-- id: 14 -->
- [x] ドキュメント (walkthrough.md) の作成 <!-- id: 15 -->
- [ ] GitコミットおよびGitHub Pull Requestの作成 <!-- id: 16 -->
  - [ ] git commit (Conventional Commits 準拠) <!-- id: 17 -->
  - [ ] fork先へのpush <!-- id: 18 -->
  - [ ] upstream (milind-soni/OpenMausBot) に対するPR作成 <!-- id: 19 -->
