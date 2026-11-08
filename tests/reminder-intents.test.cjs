const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const intents = loader()('app/assistant/reminder-intents.ts');

test('fixed Russian commands classify to their actions', () => {
  assert.equal(intents.classifyReminderAnswer('Сделано').action, 'done');
  assert.equal(intents.classifyReminderAnswer('сделано!').action, 'done');
  assert.equal(intents.classifyReminderAnswer('Готово').action, 'done');
  assert.equal(intents.classifyReminderAnswer('не сейчас').action, 'snooze');
  assert.equal(intents.classifyReminderAnswer('Не  сейчас').action, 'snooze');
  assert.equal(intents.classifyReminderAnswer('не сейчас').minutes, 0);
  assert.equal(intents.classifyReminderAnswer('Перенеси на завтра').action, 'postpone');
  assert.equal(intents.classifyReminderAnswer('завтра').action, 'postpone');
  assert.equal(intents.classifyReminderAnswer('вечером').action, 'postpone');
});

test('explicit snooze intervals parse from digits and number-words', () => {
  const cases = [
    ['через 10 минут', 10],
    ['через десять минут', 10],
    ['на 5 мин', 5],
    ['напомни через два часа', 120],
    ['через полчаса', 30],
    ['через сорок минут', 40],
    ['через 90 минут', 90],
  ];
  for (const [text, minutes] of cases) {
    const intent = intents.classifyReminderAnswer(text);
    assert.equal(intent.action, 'snooze', text);
    assert.equal(intent.minutes, minutes, text);
  }
});

test('snooze minutes clamp to a sane range', () => {
  assert.equal(intents.classifyReminderAnswer("через 1000 минут").minutes, 1000);
  assert.equal(intents.classifyReminderAnswer("через 100 часов").minutes, 1440);
  assert.equal(intents.classifyReminderAnswer('через 0 минут').minutes, 10);
});

test('free text stays other and carries the raw transcript', () => {
  const intent = intents.classifyReminderAnswer('позвони мне позже насчёт отчёта');
  assert.equal(intent.action, 'other');
  assert.equal(intent.text, 'позвони мне позже насчёт отчёта');
  // A fixed command inside a longer sentence is free text, not a command.
  assert.equal(intents.classifyReminderAnswer('сделано но там ещё правки').action, 'other');
  // A bare number is not a snooze without a minute/hour word.
  assert.equal(intents.classifyReminderAnswer('5').action, 'other');
});

test('empty transcript classifies as other with empty text', () => {
  const intent = intents.classifyReminderAnswer('   ');
  assert.equal(intent.action, 'other');
  assert.equal(intent.text, '');
});

test('normalize folds case, yo, and punctuation', () => {
  assert.equal(intents.normalizeUtterance('  СДЕЛАНО!!  '), 'сделано');
  assert.equal(intents.normalizeUtterance('Сделано.'), 'сделано');
  assert.equal(intents.normalizeUtterance('не\tсейчас'), 'не сейчас');
});
