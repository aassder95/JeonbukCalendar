const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const codePath = path.join(__dirname, '..', 'apps-script', 'Code.gs');
const context = vm.createContext({
  console,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest(algorithm, value, charset) {
      assert.equal(algorithm, 'SHA_256');
      assert.equal(charset, 'UTF_8');
      return Array.from(crypto.createHash('sha256').update(value, 'utf8').digest(), byte => (
        byte > 127 ? byte - 256 : byte
      ));
    },
  },
});
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

test('parseIcs rejects invalid dates, time zones, and end times', () => {
  assert.throws(
    () => getFunction('parseIcs')(makeCalendar(makeEvent({
      start: 'DTSTART;TZID=Asia/Seoul:20260230T140000',
    }))),
    /존재하지 않는 ICS 날짜/,
  );
  assert.throws(
    () => getFunction('parseIcs')(makeCalendar(makeEvent({
      start: 'DTSTART:20260301T140000',
    }))),
    /TZID=Asia\/Seoul/,
  );
  assert.throws(
    () => getFunction('parseIcs')(makeCalendar(makeEvent({
      end: 'DTEND;TZID=Asia/Seoul:20260301T130000',
    }))),
    /시작 또는 종료 시간이 올바르지/,
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
      patch(event, calendarId, eventId, options) {
        calls.push({ method: 'patch', event, calendarId, eventId, options });
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
  assert.equal(calls[1].method, 'patch');
  assert.equal(calls[1].eventId, 'event-1');
});

test('findTargetCalendar returns the single writable calendar with the configured name', () => {
  const config = getFunction('CONFIG');
  const expected = { id: 'calendar-1', summary: config.calendarName };
  context.Calendar = {
    CalendarList: {
      list: () => ({ items: [
        { id: 'other', summary: '다른 캘린더' },
        expected,
      ] }),
    },
  };

  assert.equal(getFunction('findTargetCalendar')(), expected);
});

test('findTargetCalendar reports zero matching calendars', () => {
  context.Calendar = {
    CalendarList: {
      list: () => ({ items: [] }),
    },
  };

  assert.throws(
    () => getFunction('findTargetCalendar')(),
    error => error.message.includes('0'),
  );
});

test('findTargetCalendar reports multiple matching calendars', () => {
  const config = getFunction('CONFIG');
  context.Calendar = {
    CalendarList: {
      list: () => ({ items: [
        { id: 'calendar-1', summary: config.calendarName },
        { id: 'calendar-2', summary: config.calendarName },
      ] }),
    },
  };

  assert.throws(
    () => getFunction('findTargetCalendar')(),
    error => error.message.includes('2'),
  );
});

test('getLabelIds returns IDs for every configured label', () => {
  const config = getFunction('CONFIG');
  context.Calendar = {
    Calendars: {
      get: calendarId => {
        assert.equal(calendarId, 'calendar-1');
        return {
          labelProperties: {
            eventLabels: config.labelNames.map((name, index) => ({ name, id: `label-${index + 1}` })),
          },
        };
      },
    },
  };

  const labelIds = getFunction('getLabelIds')('calendar-1');

  for (const [index, name] of config.labelNames.entries()) {
    assert.equal(labelIds[name], `label-${index + 1}`);
  }
});

test('getLabelIds reports configured labels missing from the calendar', () => {
  const config = getFunction('CONFIG');
  context.Calendar = {
    Calendars: {
      get: () => ({
        labelProperties: {
          eventLabels: config.labelNames.slice(0, -1).map((name, index) => ({
            name,
            id: `label-${index + 1}`,
          })),
        },
      }),
    },
  };

  assert.throws(
    () => getFunction('getLabelIds')('calendar-1'),
    error => error.message.includes(config.labelNames.at(-1)),
  );
});

test('syncJeonbuk orchestrates created, updated, unchanged, and deleted events', () => {
  const config = getFunction('CONFIG');
  const summaryPrefix = config.labelNames[0];
  const ics = makeCalendar([
    ...makeEvent({
      uid: 'created@example.com',
      summary: `[${summaryPrefix} R1] 신규 경기`,
      description: `${config.labelNames[1]} 관련 안내`,
    }),
    ...makeEvent({
      uid: 'unchanged@example.com',
      summary: `[${summaryPrefix} R2] 동일 경기`,
      description: '동일 설명',
    }),
    ...makeEvent({
      uid: 'updated@example.com',
      summary: `[${summaryPrefix} R3] 변경 경기`,
      description: '변경 설명',
    }),
  ]);
  const fixtures = getFunction('parseIcs')(ics);
  const fixtureByUid = new Map(fixtures.map(fixture => [fixture.uid, fixture]));
  const toManagedEvent = (uid, overrides = {}) => {
    const fixture = fixtureByUid.get(uid);
    return {
      id: `event-${uid}`,
      iCalUID: uid,
      summary: fixture.summary,
      location: fixture.location,
      description: fixture.description || null,
      start: fixture.start,
      end: fixture.end,
      eventLabelId: 'label-1',
      extendedProperties: {
        private: {
          jeonbukCalendarManaged: 'true',
        },
      },
      ...overrides,
    };
  };
  const managedEvents = [
    toManagedEvent('unchanged@example.com'),
    toManagedEvent('updated@example.com', { location: '이전 장소' }),
    {
      ...toManagedEvent('unchanged@example.com'),
      id: 'event-stale',
      iCalUID: 'stale@example.com',
    },
  ];
  const calls = [];
  const lock = {
    tryLock(timeout) {
      calls.push(['tryLock', timeout]);
      return true;
    },
    releaseLock() {
      calls.push(['releaseLock']);
    },
  };
  context.LockService = { getScriptLock: () => lock };
  context.UrlFetchApp = {
    fetch(url, options) {
      calls.push(['fetch', url, options]);
      return {
        getResponseCode: () => 200,
        getContentText(encoding) {
          calls.push(['getContentText', encoding]);
          return ics;
        },
      };
    },
  };
  context.Calendar = {
    CalendarList: {
      list: () => ({ items: [{ id: 'calendar-1', summary: config.calendarName }] }),
    },
    Calendars: {
      get: () => ({
        labelProperties: {
          eventLabels: config.labelNames.map((name, index) => ({ name, id: `label-${index + 1}` })),
        },
      }),
    },
    Events: {
      list(calendarId, options) {
        calls.push(['list', calendarId, options]);
        return { items: managedEvents };
      },
      import(event, calendarId, options) {
        calls.push(['import', event, calendarId, options]);
      },
      patch(event, calendarId, eventId, options) {
        calls.push(['patch', event, calendarId, eventId, options]);
      },
      remove(calendarId, eventId, options) {
        calls.push(['remove', calendarId, eventId, options]);
      },
    },
  };

  assert.throws(
    () => getFunction('syncJeonbuk')(),
    /대량 삭제 보호/,
  );
  assert.equal(calls.filter(([method]) => ['import', 'patch', 'remove'].includes(method)).length, 0);
  assert.throws(
    () => getFunction('applyJeonbuk')('incorrect-hash', true),
    /미리보기 이후 ICS가 변경/,
  );
  assert.equal(calls.filter(([method]) => ['import', 'patch', 'remove'].includes(method)).length, 0);
  const result = getFunction('applyJeonbuk')(null, true);

  assert.equal(result.created, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.unchanged, 1);
  assert.equal(result.deleted, 1);
  assert.match(result.icsHash, /^[0-9a-f]{64}$/);
  assert.equal(result.sourceVersion, config.sourceVersion);
  assert.equal(calls.filter(([method]) => method === 'import').length, 1);
  assert.equal(calls.filter(([method]) => method === 'patch').length, 1);
  assert.equal(calls.filter(([method]) => method === 'remove').length, 1);
  assert.equal(calls.find(([method]) => method === 'import')[1].eventLabelId, 'label-1');
  assert.deepEqual(calls.filter(([method]) => method === 'tryLock' || method === 'releaseLock'), [
    ['tryLock', 0],
    ['releaseLock'],
    ['tryLock', 0],
    ['releaseLock'],
    ['tryLock', 0],
    ['releaseLock'],
  ]);
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

test('large deletion protection uses count and ratio thresholds', () => {
  const isLargeDeletion = getFunction('isLargeDeletion');

  assert.equal(isLargeDeletion(0, 44), false);
  assert.equal(isLargeDeletion(1, 44), false);
  assert.equal(isLargeDeletion(5, 44), false);
  assert.equal(isLargeDeletion(6, 44), true);
  assert.equal(isLargeDeletion(3, 10), true);
});

test('the repository ICS parses to unique, recognized fixtures', () => {
  const icsPath = path.join(__dirname, '..', 'jeonbuk.ics');
  const fixtures = getFunction('parseIcs')(fs.readFileSync(icsPath, 'utf8'));
  const findLabelName = getFunction('findLabelName');

  assert.ok(fixtures.length > 0);
  assert.equal(new Set(fixtures.map(fixture => fixture.uid)).size, fixtures.length);
  for (const fixture of fixtures) {
    assert.doesNotThrow(() => findLabelName(fixture.summary));
  }
});

test('repository configuration and ICS formatting stay consistent', () => {
  const config = getFunction('CONFIG');
  const manifestPath = path.join(__dirname, '..', 'apps-script', 'appsscript.json');
  const packagePath = path.join(__dirname, '..', 'package.json');
  const icsPath = path.join(__dirname, '..', 'jeonbuk.ics');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const ics = fs.readFileSync(icsPath, 'utf8');

  assert.equal(manifest.timeZone, config.timeZone);
  assert.ok(!manifest.oauthScopes.includes('https://www.googleapis.com/auth/calendar'));
  for (const scope of [
    'https://www.googleapis.com/auth/calendar.events.owned',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.calendars.readonly',
  ]) {
    assert.ok(manifest.oauthScopes.includes(scope), scope);
  }
  assert.equal(packageJson.private, true);
  assert.match(config.icsUrl, /\/aassder95\/JeonbukCalendar\/main\/jeonbuk\.ics$/);
  for (const [index, line] of ics.split(/\r?\n/).entries()) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `ICS line ${index + 1} exceeds 75 octets`);
  }
});
