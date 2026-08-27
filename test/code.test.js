const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const codePath = path.join(__dirname, '..', 'apps-script', 'Code.gs');
const context = vm.createContext({ console });
vm.runInContext(fs.readFileSync(codePath, 'utf8'), context, { filename: codePath });

function getFunction(name) {
  return vm.runInContext(name, context);
}

function makeCalendar(events) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n');
}

function makeEvent(overrides = {}) {
  const values = {
    uid: 'fixture-1@example.com',
    summary: '[K리그1 R1] 전북 vs 서울',
    location: '전북 홈',
    description: '첫째 줄\\n둘째 줄',
    start: 'DTSTART;TZID=Asia/Seoul:20260301T140000',
    end: 'DTEND;TZID=Asia/Seoul:20260301T160000',
    ...overrides,
  };

  return [
    'BEGIN:VEVENT',
    values.start,
    values.end,
    `UID:${values.uid}`,
    `SUMMARY:${values.summary}`,
    `LOCATION:${values.location}`,
    `DESCRIPTION:${values.description}`,
    'END:VEVENT',
  ];
}

function makeManagedEvent(overrides = {}) {
  return {
    summary: '[K리그1 R1] 전북 vs 서울',
    location: '전북 홈',
    description: '설명',
    start: { dateTime: '2026-03-01T05:00:00Z' },
    end: { dateTime: '2026-03-01T07:00:00Z' },
    eventLabelId: 'label-1',
    extendedProperties: {
      private: {
        jeonbukCalendarManaged: 'true',
      },
    },
    ...overrides,
  };
}

test('parseIcs parses local date-times and escaped text', () => {
  const [fixture] = getFunction('parseIcs')(makeCalendar(makeEvent({
    location: '전북\\, 홈',
    description: '첫째 줄\\n둘째 줄\\; 확인',
  })));

  assert.equal(fixture.uid, 'fixture-1@example.com');
  assert.equal(fixture.location, '전북, 홈');
  assert.equal(fixture.description, '첫째 줄\n둘째 줄; 확인');
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.start)), {
    dateTime: '2026-03-01T14:00:00',
    timeZone: 'Asia/Seoul',
  });
});

test('parseIcs unfolds lines and parses all-day and UTC dates', () => {
  const events = [
    ...makeEvent({
      uid: 'all-day@example.com',
      summary: '[아시아챔피언스리그] 리그 스테이지 추첨',
      description: '긴 설명 첫 부분',
      start: 'DTSTART;VALUE=DATE:20260815',
      end: 'DTEND;VALUE=DATE:20260816',
    }),
    ...makeEvent({
      uid: 'utc@example.com',
      start: 'DTSTART:20260901T050000Z',
      end: 'DTEND:20260901T070000Z',
    }),
  ];
  const ics = makeCalendar(events).replace('긴 설명 첫 부분', '긴 설명 첫\r\n 부분');
  const fixtures = getFunction('parseIcs')(ics);

  assert.equal(fixtures[0].description, '긴 설명 첫부분');
  assert.deepEqual(JSON.parse(JSON.stringify(fixtures[0].start)), { date: '2026-08-15' });
  assert.deepEqual(JSON.parse(JSON.stringify(fixtures[1].start)), {
    dateTime: '2026-09-01T05:00:00Z',
  });
});

test('parseIcs rejects an incomplete calendar envelope', () => {
  assert.throws(
    () => getFunction('parseIcs')(['BEGIN:VCALENDAR', ...makeEvent()].join('\n')),
    /VCALENDAR 시작 또는 종료 표식/,
  );
});

test('parseIcs rejects an incomplete event envelope', () => {
  const malformedEvent = makeEvent().slice(0, -1);

  assert.throws(
    () => getFunction('parseIcs')(makeCalendar(malformedEvent)),
    /VEVENT 시작 또는 종료 표식 수/,
  );
});

test('parseIcs rejects blank and duplicate UIDs', () => {
  assert.throws(
    () => getFunction('parseIcs')(makeCalendar(makeEvent({ uid: '   ' }))),
    /UID가 비어/,
  );
  assert.throws(
    () => getFunction('parseIcs')(makeCalendar([...makeEvent(), ...makeEvent()])),
    /같은 UID가 여러 번/,
  );
});

test('findLabelName keeps the current competition matching behavior', () => {
  const findLabelName = getFunction('findLabelName');

  assert.equal(findLabelName('[K리그1 R1] 전북 vs 서울'), 'K리그');
  assert.equal(findLabelName('[코리아컵 16강] 전북 vs 서울'), '코리아컵');
  assert.equal(findLabelName('[슈퍼컵] 전북 vs 대전'), '슈퍼컵');
  assert.equal(findLabelName('[ACLE MD1] 전북 vs 고베'), '아시아챔피언스리그');
  assert.throws(() => findLabelName('[친선전] 전북 vs 서울'), /라벨을 판별할 수 없습니다/);
});

test('indexManagedEventsByUid rejects duplicate managed events', () => {
  const indexManagedEventsByUid = getFunction('indexManagedEventsByUid');

  assert.throws(
    () => indexManagedEventsByUid([
      { id: 'event-1', iCalUID: 'duplicate@example.com' },
      { id: 'event-2', iCalUID: 'duplicate@example.com' },
    ]),
    /Google Calendar에 같은 UID의 관리 일정이 여러 개/,
  );
});

test('areManagedEventsEqual compares only synchronized fields', () => {
  const areManagedEventsEqual = getFunction('areManagedEventsEqual');
  const expected = makeManagedEvent();

  assert.equal(areManagedEventsEqual({
    ...makeManagedEvent(),
    id: 'server-id',
    etag: 'server-etag',
    updated: '2026-08-27T00:00:00Z',
  }, expected), true);

  for (const [field, value] of [
    ['summary', '[K리그1 R1] 전북 1-0 서울'],
    ['location', '서울 원정'],
    ['description', '다른 설명'],
    ['eventLabelId', 'label-2'],
  ]) {
    assert.equal(areManagedEventsEqual(makeManagedEvent({ [field]: value }), expected), false, field);
  }
});

test('areManagedEventsEqual normalizes optional text and timed event offsets', () => {
  const areManagedEventsEqual = getFunction('areManagedEventsEqual');
  const expected = makeManagedEvent({
    location: '',
    description: null,
    start: { dateTime: '2026-03-01T14:00:00', timeZone: 'Asia/Seoul' },
    end: { dateTime: '2026-03-01T16:00:00', timeZone: 'Asia/Seoul' },
  });
  const existing = makeManagedEvent({
    location: undefined,
    description: undefined,
    start: { dateTime: '2026-03-01T05:00:00Z' },
    end: { dateTime: '2026-03-01T07:00:00Z' },
  });

  assert.equal(areManagedEventsEqual(existing, expected), true);
});

test('areManagedEventsEqual detects date and management marker changes', () => {
  const areManagedEventsEqual = getFunction('areManagedEventsEqual');
  const expectedAllDay = makeManagedEvent({
    start: { date: '2026-08-15' },
    end: { date: '2026-08-16' },
  });

  assert.equal(areManagedEventsEqual(makeManagedEvent({
    start: { date: '2026-08-16' },
    end: { date: '2026-08-17' },
  }), expectedAllDay), false);
  assert.equal(areManagedEventsEqual(makeManagedEvent(), expectedAllDay), false);
  assert.equal(areManagedEventsEqual(makeManagedEvent({
    extendedProperties: { private: { jeonbukCalendarManaged: 'false' } },
  }), makeManagedEvent()), false);
});

test('syncManagedEvent skips equal events and writes only created or changed events', () => {
  const calls = [];
  context.Calendar = {
    Events: {
      import(event, calendarId, options) {
        calls.push({ method: 'import', event, calendarId, options });
      },
      update(event, calendarId, eventId, options) {
        calls.push({ method: 'update', event, calendarId, eventId, options });
      },
    },
  };
  const syncManagedEvent = getFunction('syncManagedEvent');

  assert.equal(syncManagedEvent('calendar-1', 'uid-1', makeManagedEvent(), {
    id: 'event-1',
    ...makeManagedEvent(),
  }), 'unchanged');
  assert.equal(calls.length, 0);

  assert.equal(syncManagedEvent('calendar-1', 'uid-2', makeManagedEvent(), null), 'created');
  assert.equal(calls[0].method, 'import');
  assert.equal(calls[0].event.iCalUID, 'uid-2');

  assert.equal(syncManagedEvent('calendar-1', 'uid-1', makeManagedEvent(), {
    id: 'event-1',
    ...makeManagedEvent({ summary: '변경 전 제목' }),
  }), 'updated');
  assert.equal(calls[1].method, 'update');
  assert.equal(calls[1].eventId, 'event-1');
});

test('listManagedEvents follows page tokens and filters by the management marker', () => {
  const requests = [];
  context.Calendar = {
    Events: {
      list(calendarId, options) {
        requests.push({ calendarId, ...options });
        return options.pageToken
          ? { items: [{ id: 'event-2', iCalUID: 'uid-2' }] }
          : { items: [{ id: 'event-1', iCalUID: 'uid-1' }], nextPageToken: 'next' };
      },
    },
  };

  const events = getFunction('listManagedEvents')('calendar-1');

  assert.deepEqual(Array.from(events, event => event.id), ['event-1', 'event-2']);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].privateExtendedProperty, 'jeonbukCalendarManaged=true');
  assert.equal(requests[1].pageToken, 'next');
});

test('deleteStaleEvents removes only managed events missing from the ICS', () => {
  const removed = [];
  context.Calendar = {
    Events: {
      remove(calendarId, eventId, options) {
        removed.push({ calendarId, eventId, options });
      },
    },
  };

  const deleted = getFunction('deleteStaleEvents')('calendar-1', [
    { id: 'keep', iCalUID: 'uid-1' },
    { id: 'remove', iCalUID: 'uid-2' },
  ], new Set(['uid-1']));

  assert.equal(deleted, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(removed)), [{
    calendarId: 'calendar-1',
    eventId: 'remove',
    options: { sendUpdates: 'none' },
  }]);
});

test('the repository ICS parses to unique, recognized fixtures', () => {
  const icsPath = path.join(__dirname, '..', 'jeonbuk.ics');
  const fixtures = getFunction('parseIcs')(fs.readFileSync(icsPath, 'utf8'));
  const findLabelName = getFunction('findLabelName');

  assert.ok(fixtures.length > 0);
  assert.equal(new Set(fixtures.map(fixture => fixture.uid)).size, fixtures.length);
  for (const fixture of fixtures) {
    assert.doesNotThrow(() => findLabelName(`${fixture.summary}\n${fixture.description}`));
  }
});
