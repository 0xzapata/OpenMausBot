# 実装計画: ブラウザ通知機能（Windows/Android対応）の追加

OpenMausBotにサーバー接続時（Web UI利用時）のブラウザ通知機能を追加し、WindowsおよびAndroid端末で新しいメッセージを受信した際に通知を送信できるようにする。

これは初期計画。統合後は完了通知を既存のサーバー経路に任せ、Workerは許可済みのモバイル通知に必要な時だけ登録する。現在の動作と検証範囲は [`../verification/phone-web-app.md`](../verification/phone-web-app.md) を参照。

## 課題と解決策
1. **モバイル（Android）でのNotification制約**:
   - モバイルブラウザ（Chrome for Android等）では `new Notification(...)` が無効化されており `TypeError: Illegal constructor` となる。
   - 解決策: `public/sw.js`（Service Worker）を提供し、`ServiceWorkerRegistration.showNotification()` を使用して通知を表示する。
2. **メッセージ到着時の通知トリガー欠如**:
   - 現在のコードベースでは、タスク完了や承認要求などの `notify` SSEフレームのみ通知されていた。
   - 解決策: ボットからのテキストメッセージ到着時（`case "message":`）に、ユーザー設定（`messageNotificationsEnabled`）およびボット通知設定（`notifications !== false`）に基づいて通知を発行する。
3. **設定UIおよびパーミッション要求の不足**:
   - ブラウザ通知を明示的に有効化/無効化するUI、およびブラウザのパーミッション（Notification.permission）を要求・確認するUIがなかった。
   - 解決策: `SettingsModal.tsx` に「ブラウザ通知」設定項目を追加し、現在の許可状態の表示、許可リクエストボタン、および「メッセージ受信時の通知」トグルを配置する。

## 変更対象ファイル
- `public/sw.js`: Service Workerの新規作成（通知表示および通知クリック時のウィンドウフォーカス）
- `src/lib/notify.ts`: Service Workerの登録処理、Service Worker経由での通知表示、フォールバック処理、クリックイベント連携
- `src/lib/notification-preferences.ts`: メッセージ通知設定 (`messageNotificationsEnabled`, `setMessageNotifications`, `useMessageNotifications`) の追加
- `src/state/store.tsx`: `case "message":` における通知発行ロジックの追加、初期化時のService Worker登録
- `src/components/SettingsModal.tsx`: ブラウザ通知設定UIコンポーネント（パーミッション状態、要求ボタン、メッセージ通知トグル）の追加
- `src/locales/en.json`, `src/locales/ja.json`: 多言語文言の追加
- `src/lib/notify.test.ts`, `src/lib/notification-preferences.test.ts`: 単体テストの追加・更新

## テスト計画
- 単体テストの実行: `npx vitest run src/lib/notify.test.ts src/lib/notification-preferences.test.ts`
- ビルド確認: クライアントビルドがエラーなく通過すること
- PR作成: リポジトリにコミットをプッシュし、milind-soni/OpenMausBot にPRを作成
