const CONFIG = {
  calendarName: '전북현대',
  icsUrl: 'https://raw.githubusercontent.com/aassder95/JeonbukCalendar/main/jeonbuk.ics',
  timeZone: 'Asia/Seoul',
  timeZoneOffset: '+09:00',
  managedPropertyName: 'jeonbukCalendarManaged',
  managedPropertyValue: 'true',
  labelNames: [
    'K리그',
    '코리아컵',
    '슈퍼컵',
    '아시아챔피언스리그',
  ],
};

function syncJeonbuk() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    throw new Error('이미 다른 동기화가 진행 중입니다.');
  }

  try {
    const calendar = findTargetCalendar();
    const labelIds = getLabelIds(calendar.id);
    const ics = UrlFetchApp.fetch(CONFIG.icsUrl).getContentText('UTF-8');
    const fixtures = parseIcs(ics);
    if (fixtures.length === 0) throw new Error('ICS 일정이 0건이므로 동기화를 중단합니다.');

    const currentUids = new Set(fixtures.map(fixture => fixture.uid));
    const managedEvents = listManagedEvents(calendar.id);
    const managedEventsByUid = indexManagedEventsByUid(managedEvents);

    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (const fixture of fixtures) {
      const labelName = findLabelName(fixture.summary);
      const event = {
        summary: fixture.summary,
        location: fixture.location,
        description: fixture.description || null,
        start: fixture.start,
        end: fixture.end,
        eventLabelId: labelIds[labelName],
        extendedProperties: {
          private: {
            [CONFIG.managedPropertyName]: CONFIG.managedPropertyValue,
          },
        },
      };
      const existing = managedEventsByUid.get(fixture.uid);
      const result = syncManagedEvent(calendar.id, fixture.uid, event, existing);

      if (result === 'created') created++;
      if (result === 'updated') updated++;
      if (result === 'unchanged') unchanged++;
    }

    const deleted = deleteStaleEvents(calendar.id, managedEvents, currentUids);
    console.log(`동기화 완료: 추가 ${created}건, 수정 ${updated}건, 변경 없음 ${unchanged}건, 삭제 ${deleted}건`);
    return { created, updated, unchanged, deleted };
  } finally {
    lock.releaseLock();
  }
}

function syncManagedEvent(calendarId, uid, event, existing) {
  if (!existing) {
    event.iCalUID = uid;
    Calendar.Events.import(event, calendarId, {
      eventLabelVersion: 1,
    });
    return 'created';
  }

  if (areManagedEventsEqual(existing, event)) return 'unchanged';

  Calendar.Events.update(event, calendarId, existing.id, {
    eventLabelVersion: 1,
    sendUpdates: 'none',
  });
  return 'updated';
}

function areManagedEventsEqual(existing, expected) {
  return existing.summary === expected.summary
    && normalizeOptionalText(existing.location) === normalizeOptionalText(expected.location)
    && normalizeOptionalText(existing.description) === normalizeOptionalText(expected.description)
    && areEventDatesEqual(existing.start, expected.start)
    && areEventDatesEqual(existing.end, expected.end)
    && existing.eventLabelId === expected.eventLabelId
    && getManagedProperty(existing) === getManagedProperty(expected);
}

function normalizeOptionalText(value) {
  return value ?? '';
}

function areEventDatesEqual(existing, expected) {
  if (!existing || !expected) return existing === expected;

  const existingIsAllDay = typeof existing.date === 'string';
  const expectedIsAllDay = typeof expected.date === 'string';
  if (existingIsAllDay || expectedIsAllDay) {
    return existingIsAllDay && expectedIsAllDay && existing.date === expected.date;
  }

  if (typeof existing.dateTime !== 'string' || typeof expected.dateTime !== 'string') return false;
  const existingTime = parseEventDateTime(existing);
  const expectedTime = parseEventDateTime(expected);
  if (Number.isNaN(existingTime) || Number.isNaN(expectedTime)) {
    return existing.dateTime === expected.dateTime && existing.timeZone === expected.timeZone;
  }
  return existingTime === expectedTime;
}

function parseEventDateTime(value) {
  const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/.test(value.dateTime);
  const dateTime = !hasOffset && value.timeZone === CONFIG.timeZone
    ? `${value.dateTime}${CONFIG.timeZoneOffset}`
    : value.dateTime;
  return Date.parse(dateTime);
}

function getManagedProperty(event) {
  return event.extendedProperties?.private?.[CONFIG.managedPropertyName];
}

function listManagedEvents(calendarId) {
  const events = [];
  let pageToken = null;

  do {
    const options = {
      maxResults: 2500,
      privateExtendedProperty: `${CONFIG.managedPropertyName}=${CONFIG.managedPropertyValue}`,
      showDeleted: false,
    };
    if (pageToken) options.pageToken = pageToken;

    const response = Calendar.Events.list(calendarId, options);
    events.push(...(response.items || []));

    pageToken = response.nextPageToken || null;
  } while (pageToken);

  return events;
}

function indexManagedEventsByUid(events) {
  const eventsByUid = new Map();

  for (const event of events) {
    if (!event.iCalUID) continue;
    if (eventsByUid.has(event.iCalUID)) {
      throw new Error(`Google Calendar에 같은 UID의 관리 일정이 여러 개 있습니다: ${event.iCalUID}`);
    }
    eventsByUid.set(event.iCalUID, event);
  }

  return eventsByUid;
}

function deleteStaleEvents(calendarId, managedEvents, currentUids) {
  let deleted = 0;

  for (const event of managedEvents) {
    if (currentUids.has(event.iCalUID)) continue;
    Calendar.Events.remove(calendarId, event.id, { sendUpdates: 'none' });
    deleted++;
  }

  return deleted;
}

function installDailyTrigger() {
  const duplicateTriggers = ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'syncJeonbuk');
  for (const trigger of duplicateTriggers) {
    ScriptApp.deleteTrigger(trigger);
  }

  ScriptApp.newTrigger('syncJeonbuk')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();
}

function findTargetCalendar() {
  const items = Calendar.CalendarList.list({
    maxResults: 250,
    minAccessRole: 'writer',
  }).items || [];
  const matches = items.filter(item => item.summary === CONFIG.calendarName);

  if (matches.length !== 1) {
    throw new Error(`쓰기 가능한 '${CONFIG.calendarName}' 캘린더가 ${matches.length}개입니다.`);
  }

  return matches[0];
}

function getLabelIds(calendarId) {
  const calendar = Calendar.Calendars.get(calendarId);
  const labels = calendar.labelProperties?.eventLabels || [];
  const labelIds = {};

  for (const label of labels) {
    labelIds[label.name] = label.id;
  }

  const missingNames = CONFIG.labelNames.filter(name => !labelIds[name]);
  if (missingNames.length > 0) {
    throw new Error(`캘린더 라벨을 찾을 수 없습니다: ${missingNames.join(', ')}`);
  }

  return labelIds;
}

function findLabelName(text) {
  if (text.includes('코리아컵')) return '코리아컵';
  if (text.includes('슈퍼컵')) return '슈퍼컵';
  if (text.includes('아시아챔피언스리그') || text.includes('ACLE') || text.includes('ACL Elite')) {
    return '아시아챔피언스리그';
  }
  if (text.includes('K리그')) return 'K리그';
  throw new Error(`대회 라벨을 판별할 수 없습니다: ${text.split('\n')[0]}`);
}

function parseIcs(ics) {
  const unfolded = ics.replace(/\r?\n[ \t]/g, '');
  const trimmed = unfolded.trim();
  if (!trimmed.startsWith('BEGIN:VCALENDAR') || !trimmed.endsWith('END:VCALENDAR')) {
    throw new Error('ICS의 VCALENDAR 시작 또는 종료 표식이 올바르지 않습니다.');
  }
  const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  const eventStartCount = (unfolded.match(/(?:^|\r?\n)BEGIN:VEVENT(?:\r?\n|$)/g) || []).length;
  const eventEndCount = (unfolded.match(/(?:^|\r?\n)END:VEVENT(?:\r?\n|$)/g) || []).length;
  if (blocks.length !== eventStartCount || blocks.length !== eventEndCount) {
    throw new Error('ICS의 VEVENT 시작 또는 종료 표식 수가 일치하지 않습니다.');
  }

  const fixtures = blocks.map(block => {
    const startLine = getPropertyLine(block, 'DTSTART');
    const endLine = getPropertyLine(block, 'DTEND');
    return {
      uid: getPropertyValue(block, 'UID'),
      summary: unescapeIcs(getPropertyValue(block, 'SUMMARY')),
      location: unescapeIcs(getPropertyValue(block, 'LOCATION', false)),
      description: unescapeIcs(getPropertyValue(block, 'DESCRIPTION', false)),
      start: parseIcsDate(startLine),
      end: parseIcsDate(endLine),
    };
  });

  validateFixtureUids(fixtures);
  return fixtures;
}

function validateFixtureUids(fixtures) {
  const uids = new Set();

  for (const fixture of fixtures) {
    if (!fixture.uid.trim()) {
      throw new Error('ICS 일정의 UID가 비어 있습니다.');
    }
    if (uids.has(fixture.uid)) {
      throw new Error(`ICS에 같은 UID가 여러 번 있습니다: ${fixture.uid}`);
    }
    uids.add(fixture.uid);
  }
}

function getPropertyLine(block, name) {
  const line = block.split(/\r?\n/).find(value => value.startsWith(`${name}:`) || value.startsWith(`${name};`));
  if (!line) throw new Error(`ICS에서 ${name} 값을 찾을 수 없습니다.`);
  return line;
}

function getPropertyValue(block, name, required = true) {
  const line = block.split(/\r?\n/).find(value => value.startsWith(`${name}:`) || value.startsWith(`${name};`));
  if (!line) {
    if (required) throw new Error(`ICS에서 ${name} 값을 찾을 수 없습니다.`);
    return '';
  }
  return line.substring(line.indexOf(':') + 1);
}

function parseIcsDate(line) {
  const value = line.substring(line.indexOf(':') + 1);
  if (/^\d{8}$/.test(value)) {
    return { date: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` };
  }

  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) throw new Error(`지원하지 않는 ICS 날짜 형식입니다: ${value}`);

  const dateTime = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  return match[7] === 'Z'
    ? { dateTime: `${dateTime}Z` }
    : { dateTime, timeZone: CONFIG.timeZone };
}

function unescapeIcs(value) {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}
