const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const mod = loader()('app/ui/custom-notifications.ts');

function notification(overrides = {}) {
  return {
    key: 'ticktick-key', packageName: 'com.ticktick.task', appName: 'TickTick',
    title: 'Позвонить маме', text: 'сегодня в 19:00', bigText: '', subText: '',
    infoText: '', summaryText: '', category: 'reminder', lines: [], postTime: 1,
    when: 1, actions: [{ index: 2, title: 'Выполнить', enabled: true }],
    ...overrides,
  };
}

test('the registry selects TickTick packages without taking over other apps', () => {
  assert.equal(mod.customNotificationProfileFor(notification()).id, 'ticktick');
  assert.equal(mod.customNotificationProfileFor(notification({ packageName: 'com.ticktick.task.beta' })).id, 'ticktick');
  assert.equal(mod.customNotificationProfileFor(notification({ packageName: 'cn.ticktick.task' })).id, 'ticktick');
  assert.equal(mod.customNotificationProfileFor(notification({ packageName: 'com.example.calendar' })), null);
  assert.equal(mod.tickTickNotificationProfile.reappearAfterMs, 60_000);
});

test('TickTick text is compact and duplicate fields are omitted', () => {
  const n = notification({ bigText: 'Позвонить маме', lines: ['сегодня в 19:00'] });
  assert.equal(mod.tickTickTaskLabel(n), 'Позвонить маме');
  assert.equal(mod.tickTickNotificationBody(n), 'Позвонить маме - сегодня в 19:00');
});

test('completion actions are found in Russian and English but disabled actions are ignored', () => {
  assert.equal(mod.tickTickCompleteAction(notification()).index, 2);
  assert.equal(mod.tickTickCompleteAction(notification({ actions: [
    { index: 0, title: 'Mark as done', enabled: true },
  ] })).index, 0);
  assert.equal(mod.tickTickCompleteAction(notification({ actions: [
    { index: 0, title: 'Готово', enabled: false },
  ] })), null);
});

test('simple spoken commands stay local', () => {
  const profile = mod.tickTickNotificationProfile;
  const done = profile.voiceDecision(notification(), 'Сделано');
  assert.equal(done.kind, 'action');
  assert.equal(done.actionIndex, 2);
  const tenMinutes = profile.voiceDecision(notification(), 'Отложи на 10 минут');
  assert.equal(tenMinutes.kind, 'snooze');
  assert.equal(tenMinutes.minutes, 10);
  const later = profile.voiceDecision(notification(), 'не сейчас');
  assert.equal(later.kind, 'snooze');
  assert.equal(later.minutes, mod.TICKTICK_DEFAULT_SNOOZE_MS / 60_000);
});

test('complex or ambiguous speech opens an ordinary Nano chat immediately', () => {
  const decision = mod.tickTickNotificationProfile.voiceDecision(notification(), 'перенеси на вечер');
  assert.equal(decision.kind, 'assistant');
  assert.equal(decision.message, 'По задаче TickTick «Позвонить маме»: перенеси на вечер');
});

function telegramNotification(overrides = {}) {
  return notification({
    key: 'telegram-key', packageName: 'org.telegram.messenger', appName: 'Telegram',
    title: 'Алексей', text: 'Ты сегодня будешь?', category: 'msg',
    actions: [
      { index: 0, title: 'Прочитано', enabled: true, semanticAction: 2, hasRemoteInput: false },
      { index: 1, title: 'Ответить', enabled: true, semanticAction: 1, hasRemoteInput: true },
    ],
    ...overrides,
  });
}

test('the registry selects Telegram variants and separates sender from message', () => {
  const profile = mod.customNotificationProfileFor(telegramNotification());
  assert.equal(profile.id, 'telegram');
  assert.equal(mod.customNotificationProfileFor(telegramNotification({ packageName: 'org.telegram.messenger.web' })).id, 'telegram');
  assert.equal(mod.telegramSender(telegramNotification()), 'Алексей');
  assert.equal(mod.telegramNotificationBody(telegramNotification()), 'Ты сегодня будешь?');
  assert.match(profile.hint(telegramNotification(), true), /●— прочитано\s+●● закрыть\s+— ответ\s+▲▼ прокрутка/);
  assert.equal(profile.longPressOpensVoice, true);
  assert.equal(profile.scrollableBody, true);
  assert.equal(profile.headerDivider, true);
  assert.equal(profile.sourceIcon, true);
  assert.equal(profile.doubleClickDecision(telegramNotification()).kind, 'close');
});

test('Telegram actions prefer Android semantics and RemoteInput capability', () => {
  const n = telegramNotification();
  assert.equal(mod.telegramMarkReadAction(n).index, 0);
  assert.equal(mod.telegramReplyAction(n).index, 1);
  const localized = telegramNotification({ actions: [
    { index: 4, title: 'MARK AS READ', enabled: true },
    { index: 5, title: 'REPLY', enabled: true, hasRemoteInput: true },
  ] });
  assert.equal(mod.telegramMarkReadAction(localized).index, 4);
  assert.equal(mod.telegramReplyAction(localized).index, 5);
});

test('Telegram voice always becomes a native notification reply', () => {
  const decision = mod.telegramNotificationProfile.voiceDecision(telegramNotification(), ' Да, буду ');
  assert.equal(decision.kind, 'reply');
  assert.equal(decision.actionIndex, 1);
  assert.equal(decision.text, 'Да, буду');
});
