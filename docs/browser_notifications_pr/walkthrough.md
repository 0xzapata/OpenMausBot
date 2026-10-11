# ウォークスルー: ブラウザ通知（Windows/Android）機能の実装と検証

OpenMausBotのWeb UIにおいて、新しいメッセージが到着した際にWindowsやAndroid端末のブラウザへ通知を送信できるようにする機能を追加しました。

## 変更内容の概要

### 1. Service Workerによるクロスプラットフォーム通知基盤 (`public/sw.js`)
- モバイルブラウザ（Android Chrome等）では `new Notification()` コンストラクタがブロックされているため、Service Workerの `registration.showNotification()` を利用する基盤を追加。
- 通知タップ時にブラウザウィンドウにフォーカスを戻し、対象の会話スレッドを開くハンドラーを実装。

### 2. Service Workerおよび通知クライアント連携 (`src/lib/notify.ts`)
- `initNotificationServiceWorker()` を新設し、Service Worker (`/sw.js`) の登録と通知クリックメッセージのリスニングを実装。
- `showNotification()` において、Service Workerが利用可能な環境では `registration.showNotification()` を優先し、従来の `new Notification()` を安全なフォールバックとして処理。

### 3. メッセージ通知設定管理 (`src/lib/notification-preferences.ts`)
- `MESSAGE_NOTIFICATIONS_KEY = "omb-message-notifications"` を追加。
- `messageNotificationsEnabled()` / `setMessageNotifications()` / `useMessageNotifications()` を追加し、ユーザーがメッセージ到着時通知をON/OFF可能に。

### 4. メッセージ到着時の通知トリガー (`src/state/store.tsx`)
- ボットから新しいテキストメッセージを受信した際（`case "message":`）、ユーザー設定およびボットの通知許可設定（`notifications !== false`）に基づき `showNotification()` を実行。
- ユーザーが現在アクティブに閲覧しているスレッドは重複して通知しない既存の安全ガードを継承。
- アプリ起動時に `initNotificationServiceWorker()` を呼び出し。

### 5. 設定画面UIの実装 (`src/components/SettingsModal.tsx`)
- 「外観（Appearance）」セクションに `BrowserNotificationsRow` を追加。
- ブラウザの通知パーミッション（未許可、許可済み、拒否）に応じた状態表示と「通知を許可する（Enable notifications）」ボタンを配置。
- 「新しいメッセージの通知」トグルスイッチを配置。

### 6. 多言語対応 (`src/locales/`)
- `en.json`、`ja.json` に設定文言を追加。
- `source-hashes.json` を更新し、`pnpm i18n:check` の完全適合を確認。

## 検証結果
- `pnpm i18n:check`: PASS (10言語カタログ適合)
- `pnpm lint`: PASS (0 errors, 0 warnings)
- `pnpm typecheck`: PASS
- `pnpm vitest run src/lib/notify.test.ts src/lib/notification-preferences.test.ts src/components/SettingsModal.appearance.test.ts src/components/SettingsModal.groups.test.ts`: PASS (全テスト通過)
- `pnpm build`: PASS (本番ビルド成功)
