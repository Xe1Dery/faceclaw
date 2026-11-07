# Итог работы над голосовым интерфейсом Faceclaw

Исходная версия: `b353483ac2a7f4b0f1cc69613bbebd48cd3163d7`, репозиторий `https://github.com/jimrandomh/faceclaw`. Рабочий checkout: `/workspace/work/faceclaw`.

## Изменения и коммиты

1. `8e73e95` — аудит до изменения кода: `voice-interface-audit.md`.
2. `eb7970a` — WS/WSS, автоматические порты 8790/443, сохранение явных портов и старых WS-настроек, валидация endpoint, hello token, штатный Android TLS, запрет перенаправлений, защита от событий старого соединения. Пример Nginx — `nginx-agent-bridge.conf`.
3. `399de14` — раннее включение G2-аудио, bounded FIFO на 400 пакетов с явным отказом при переполнении, владение конкретным packet source, блокировка перекрывающихся worker, Android warm recognizer с эксклюзивным lease. Смена модели, memory trim, close и ошибка decode инвалидируют кэш; активный recognizer освобождается после возврата lease. OfflineStream и LC3-декодер остаются посессионными. Добавлены monotonic timestamps; убраны transcript preview из Logcat.
4. `c9fa52c` — отдельный локальный multilingual Whisper base int8, русский/английский/авто, immutable model revision и SHA-256, snapshot модели/языка на сессию; английские Moonshine/base.en сохраняются.

Основные изменённые файлы:

| Область | Файлы |
| --- | --- |
| WSS | `app/assistant/bridge-client.ts`, новый `bridge-endpoint.ts`, `types.ts`; `FaceclawWebSocket.kt`; настройки, меню, dashboard controller и shell |
| Android STT | `App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawVoiceController.kt`, `AndroidSpeechEngines.kt` |
| Общая сессия | `native/kotlin/shared/src/commonMain/kotlin/com/faceclaw/app/audio/VoiceCaptureSession.kt`, `VoicePorts.kt`, новый `WarmTranscriber.kt`; `GlassesSessionCore.kt` |
| JS и модели | `app/native/voice-control.ts`, `app/native/asr-model.ts`, `app/bootstrap.android.ts`, `app/ui/dashboard-settings.ts`, `app/ui/dashboard/settings-menus.ts`, `app/g2/dashboard-controller.ts` |
| Тесты | новые `bridge-transport.test.cjs`, `voice-settings.test.cjs`, `WarmTranscriberTest.kt`; обновлены `VoiceCaptureSessionTest.kt`, `voice-finalization.test.cjs`, `assistant-settings-visibility.test.cjs` |
| Замеры | `scripts/voice-timing-summary.py`, `notes/voice-baseline-timing.patch`, протокол `voice-interface-validation.md` |

## Проверки

* `npm test`: **1144 passed, 3 skipped, 0 failed** (1147 тестов).
* Полный `npm run test:kotlin`: **363 passed**, без ошибок. После последних дополнений отдельно повторены **17 целевых Kotlin-тестов**, все прошли (13 сессии + 4 кэша). Проверены ранняя буферизация/копирование исходного пакета, порядок без дублей, отмена при cold load, запрет перекрывающихся worker, overflow, Bluetooth disconnect и старые callbacks, snapshot языка/модели, повторное использование, deferred release и ошибка decode.
* `npx tsc --noEmit`: успешно. Линтер изменённых TS-файлов: без замечаний.
* Общий Kotlin Android AAR: успешная сборка с warnings-as-errors.
* NativeScript Android build: успешно; затем повторный `assembleDebug` с последним AAR и регенерацией native metadata: exit 0. Собраны arm64 JNI sherpa/LC3/llama. Промежуточный сбой из-за удаления Build Tools при освобождении места исправлен восстановлением SDK; итоговый APK пересобран.
* Финальный APK: ZIP integrity, наличие native metadata с `setOnboardLanguage`, arm64 sherpa JNI и подпись APK v2 проверены.
* Локальные ONNX base/small проверены в sherpa-onnx 1.13.0 на Linux. Все скачанные SHA-256 совпали. Подробности и ограничения — `voice-stt-smoke-results.md`.

## APK

`platforms/android/app/build/outputs/apk/debug/app-debug.apk`

Размер: **111453402 bytes** (~106.3 MiB), debug, arm64.

SHA-256: `0ee21f59105a612c441e9eba31dc9ae02cc9cf237b55707a4df0e7b1416cd324`.

Сборка/установка/откат и настройка WSS/RU описаны в `voice-interface-validation.md`. Базовые команды: `npm ci`, `npm test`, `npm run test:kotlin`, `./build.sh`, затем `adb install -r platforms/android/app/build/outputs/apk/debug/app-debug.apk`. Для работы NativeScript CLI могут потребоваться также SDK emulator tools (образ эмулятора для сборки APK не нужен). Debug APK требует совместимой подписи установленного приложения; перед заменой сохранить настройки и прежний APK.

## Что остаётся проверить на устройстве

* Телефон/G2 не подключены: реальные значения wake→first_packet до/после, Bluetooth startup и native heap после 50 сессий **не измерены**. Исходный serial load обнаружен по коду; вклад в наблюдаемые 2–3 s остаётся гипотезой. Есть baseline timing patch и скрипт median/p95 для одинаковых замеров на двух версиях.
* Реальное соединение через пользовательский Nginx/TLS и прежний WS/Tailscale проверяются по протоколу; unit-тесты TLS failure используют native boundary stub, а не реальный Android certificate handshake.
* RU/EN распознавание локально работает на публичных аудиопримерах. Качественное распознавание команд G2 **не подтверждено**. На искусственном 8 s RU→EN примере оба Whisper base/small пропустили английскую часть; этот тест **не пройден**. Small оказался медленнее и не исправил этот случай, поэтому оставлен base. Реальные смешанные команды требуют отдельного корпуса; возможный следующий кандидат для специализированного RU-режима — GigaAM под тем же sherpa runtime.

Не все аппаратные критерии готовности можно считать закрытыми. Изменения, тесты, APK и инструменты замеров готовы к проверке на телефоне.
