const CONFIG = {
  sourceVersion: '2026-08-27.1',
  calendarName: '전북현대',
  icsUrl: 'https://raw.githubusercontent.com/aassder95/JeonbukCalendar/main/jeonbuk.ics',
  timeZone: 'Asia/Seoul',
  timeZoneOffset: '+09:00',
  managedPropertyName: 'jeonbukCalendarManaged',
  managedPropertyValue: 'true',
  maxAutomaticDeleteCount: 5,
  maxAutomaticDeleteRatio: 0.2,
  labelNames: [
    'K리그',
    '코리아컵',
    '슈퍼컵',
    '아시아챔피언스리그',
  ],
};

function syncJeonbuk() {
  return applyJeonbuk(null, false);
}

function previewJeonbuk() {
  return withSyncLock(() => toPublicSyncPlan(buildSyncPlan()));
}

function applyJeonbuk(expectedIcsHash, allowLargeDelete = false) {
  return withSyncLock(() => {
    const plan = buildSyncPlan();
    if (expectedIcsHash && expectedIcsHash !== plan.icsHash) {
      throw new Error(`미리보기 이후 ICS가 변경되었습니다. 예상 ${expectedIcsHash}, 현재 ${plan.icsHash}`);
    }
    if (plan.requiresDeleteConfirmation && allowLargeDelete !== true) {
      throw new Error(
        `대량 삭제 보호가 동기화를 중단했습니다: 관리 일정 ${plan.managedCount}건 중 ${plan.deleted.length}건 삭제 예정. `
        + `previewJeonbuk() 결과를 확인한 뒤 같은 ICS 해시로 명시 승인하세요.`,
      );
    }

    for (const change of plan.created) {
      syncManagedEvent(plan.calendarId, change.uid, change.event, null);
    }
    for (const change of plan.updated) {
      syncManagedEvent(plan.calendarId, change.uid, change.event, change.existing);
    }
    for (const change of plan.deleted) {
      Calendar.Events.remove(plan.calendarId, change.id, { sendUpdates: 'none' });
    }

    const result = {
      created: plan.created.length,
      updated: plan.updated.length,
      unchanged: plan.unchanged.length,
      deleted: plan.deleted.length,
      icsHash: plan.icsHash,
      sourceVersion: CONFIG.sourceVersion,
    };
    console.log(
      `동기화 완료: 추가 ${result.created}건, 수정 ${result.updated}건, `
      + `변경 없음 ${result.unchanged}건, 삭제 ${result.deleted}건`,
    );
    return result;
  });
}

function withSyncLock(callback) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    throw new Error('이미 다른 동기화가 진행 중입니다.');
  }

  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function buildSyncPlan() {
  const calendar = findTargetCalendar();
  const labelIds = getLabelIds(calendar.id);
  const response = UrlFetchApp.fetch(CONFIG.icsUrl, { muteHttpExceptions: true });
  const responseCode = response.getResponseCode();
  if (responseCode !== 200) {
    throw new Error(`ICS 다운로드에 실패했습니다. HTTP ${responseCode}`);
  }
  const ics = response.getContentText('UTF-8');
  const fixtures = parseIcs(ics);
  if (fixtures.length === 0) throw new Error('ICS 일정이 0건이므로 동기화를 중단합니다.');

  const prepared = fixtures.map(fixture => ({
    uid: fixture.uid,
    summary: fixture.summary,
    event: makeManagedEventResource(fixture, labelIds),
  }));
  const currentUids = new Set(prepared.map(change => change.uid));
  const managedEvents = listManagedEvents(calendar.id);
  const managedEventsByUid = indexManagedEventsByUid(managedEvents);
  const plan = {
    calendarId: calendar.id,
    managedCount: managedEvents.length,
    icsHash: getIcsHash(ics),
    created: [],
    updated: [],
    unchanged: [],
    deleted: [],
  };

  for (const change of prepared) {
    const existing = managedEventsByUid.get(change.uid);
    if (!existing) {
      plan.created.push(change);
    } else if (areManagedEventsEqual(existing, change.event)) {
      plan.unchanged.push(change);
    } else {
      plan.updated.push({ ...change, existing });
    }
  }
  plan.deleted = managedEvents
    .filter(event => !currentUids.has(event.iCalUID))
    .map(event => ({ id: event.id, uid: event.iCalUID || '', summary: event.summary || '' }));
  plan.requiresDeleteConfirmation = isLargeDeletion(plan.deleted.length, managedEvents.length);
  return plan;
}

function makeManagedEventResource(fixture, labelIds) {
  const labelName = findLabelName(fixture.summary);
  return {
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
}

function isLargeDeletion(deletedCount, managedCount) {
  if (deletedCount === 0) return false;
  return deletedCount > CONFIG.maxAutomaticDeleteCount
    || managedCount > 0 && deletedCount / managedCount > CONFIG.maxAutomaticDeleteRatio;
}

function toPublicSyncPlan(plan) {
  const summarize = change => ({ uid: change.uid, summary: change.summary });
  return {
    created: plan.created.length,
    updated: plan.updated.length,
    unchanged: plan.unchanged.length,
    deleted: plan.deleted.length,
    icsHash: plan.icsHash,
    sourceVersion: CONFIG.sourceVersion,
    managedCount: plan.managedCount,
    requiresDeleteConfirmation: plan.requiresDeleteConfirmation,
    changes: {
      created: plan.created.map(summarize),
      updated: plan.updated.map(summarize),
      deleted: plan.deleted.map(summarize),
    },
  };
}

function getIcsHash(ics) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    ics,
    Utilities.Charset.UTF_8,
  );
  return digest.map(value => (value < 0 ? value + 256 : value).toString(16).padStart(2, '0')).join('');
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

  Calendar.Events.patch(event, calendarId, existing.id, {
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
  validateFixtures(fixtures);
  return fixtures;
}

function validateFixtures(fixtures) {
  for (const fixture of fixtures) {
    const startIsAllDay = typeof fixture.start.date === 'string';
    const endIsAllDay = typeof fixture.end.date === 'string';
    if (startIsAllDay !== endIsAllDay) {
      throw new Error(`ICS 일정의 시작과 종료 형식이 다릅니다: ${fixture.uid}`);
    }

    const startTime = startIsAllDay
      ? Date.parse(`${fixture.start.date}T00:00:00Z`)
      : parseEventDateTime(fixture.start);
    const endTime = endIsAllDay
      ? Date.parse(`${fixture.end.date}T00:00:00Z`)
      : parseEventDateTime(fixture.end);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
      throw new Error(`ICS 일정의 시작 또는 종료 시간이 올바르지 않습니다: ${fixture.uid}`);
    }
  }
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
  const propertyPart = line.substring(0, line.indexOf(':'));
  const value = line.substring(line.indexOf(':') + 1);
  if (/^\d{8}$/.test(value)) {
    if (!propertyPart.includes('VALUE=DATE')) {
      throw new Error(`종일 일정에는 VALUE=DATE가 필요합니다: ${line}`);
    }
    validateCalendarDate(value);
    return { date: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` };
  }

  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) throw new Error(`지원하지 않는 ICS 날짜 형식입니다: ${value}`);
  validateCalendarDate(value.slice(0, 8));
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) {
    throw new Error(`지원하지 않는 ICS 날짜 형식입니다: ${value}`);
  }
  const isUtc = match[7] === 'Z';
  const timeZoneMatch = propertyPart.match(/(?:^|;)TZID=([^;]+)/);
  if (!isUtc && timeZoneMatch?.[1] !== CONFIG.timeZone) {
    throw new Error(`로컬 시간에는 TZID=${CONFIG.timeZone}가 필요합니다: ${line}`);
  }

  const dateTime = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  return isUtc
    ? { dateTime: `${dateTime}Z` }
    : { dateTime, timeZone: CONFIG.timeZone };
}

function validateCalendarDate(value) {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`존재하지 않는 ICS 날짜입니다: ${value}`);
  }
}

function unescapeIcs(value) {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}
