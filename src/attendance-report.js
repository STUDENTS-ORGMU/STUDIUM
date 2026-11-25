const monthNames = [
  'ЯНВАРЬ', 'ФЕВРАЛЬ', 'МАРТ', 'АПРЕЛЬ', 'МАЙ', 'ИЮНЬ',
  'ИЮЛЬ', 'АВГУСТ', 'СЕНТЯБРЬ', 'ОКТЯБРЬ', 'НОЯБРЬ', 'ДЕКАБРЬ'
];

const monthNamesShort = [
  'янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июня',
  'июля', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'
];

const schedulePeriods = [
  { start: '08:30', end: '10:00' },
  { start: '10:30', end: '12:00' },
  { start: '13:00', end: '14:30' },
  { start: '15:00', end: '16:30' }
];

function normalizeDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (value && typeof value.toDate === 'function') {
    const date = value.toDate();
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }
  return '';
}

function periodsForLesson(lesson) {
  const saved = Number(lesson?.periodCount);
  if (Number.isInteger(saved) && saved >= 1 && saved <= 4) return saved;
  const start = schedulePeriods.findIndex(item => item.start === lesson?.startsAt);
  const end = schedulePeriods.findIndex(item => item.end === lesson?.endsAt);
  return start >= 0 && end >= start ? end - start + 1 : 1;
}

function lessonCategory(lesson) {
  const descriptor = [
    lesson?.lessonType, lesson?.type, lesson?.kind, lesson?.subject
  ].filter(Boolean).join(' ').toLocaleLowerCase('ru-RU');
  return /лекц|lecture/.test(descriptor) ? 'лекция' : 'семинар';
}

function cleanSubject(value) {
  return String(value || 'Без названия').replace(
    /\s*[·—-]\s*(лекция|семинар|практика|практическое занятие|лабораторная работа)\s*$/iu,
    ''
  ).trim();
}

function dateLabel(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return day + ' ' + monthNamesShort[month - 1] + ' ' + year;
}

function attendanceEvents(records, lessonsById) {
  const byLessonAndDate = new Map();
  records.forEach(record => {
    const lesson = lessonsById.get(record.lessonId);
    if (!lesson || record.source !== 'leader') return;
    if (!['present', 'absent', 'excused', 'late', 'unmarked'].includes(record.status)) return;
    const date = normalizeDate(record.lessonDate);
    if (!date) return;
    const key = record.lessonId + '|' + date + '|' + record.studentId;
    if (!byLessonAndDate.has(key)) byLessonAndDate.set(key, []);
    byLessonAndDate.get(key).push({ ...record, normalizedDate: date, lesson });
  });

  const events = [];
  byLessonAndDate.forEach(items => {
    const lesson = items[0].lesson;
    const duration = periodsForLesson(lesson);
    const legacy = items.find(item => !item.partKey) || null;
    const partRecords = new Map(items.filter(item => item.partKey).map(item => [item.partKey, item]));

    if (partRecords.size === 0 && legacy) {
      if (!['absent', 'excused'].includes(legacy.status)) return;
      events.push({
        studentId: legacy.studentId,
        lessonId: lesson.id,
        date: legacy.normalizedDate,
        type: lessonCategory(lesson),
        subject: cleanSubject(lesson.subject),
        hours: duration * 2,
        pairs: duration,
        reason: legacy.status === 'excused' ? 'уважительно' : 'неуважительно'
      });
      return;
    }

    for (let part = 1; part <= duration; part++) {
      const exact = partRecords.get('part' + part);
      const effective = exact || legacy;
      if (!effective || !['absent', 'excused'].includes(effective.status)) continue;
      events.push({
        studentId: effective.studentId,
        lessonId: lesson.id,
        date: effective.normalizedDate,
        type: lessonCategory(lesson),
        subject: cleanSubject(lesson.subject),
        hours: 2,
        pairs: 1,
        reason: effective.status === 'excused' ? 'уважительно' : 'неуважительно'
      });
    }
  });

  return events.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    a.subject.localeCompare(b.subject, 'ru') ||
    a.studentId.localeCompare(b.studentId, 'ru')
  );
}

function eachCellInRect(sheet, startRow, startCol, endRow, endCol, callback) {
  for (let row = startRow; row <= endRow; row++) {
    for (let col = startCol; col <= endCol; col++) callback(sheet.getCell(row, col), row, col);
  }
}

function styleRect(sheet, startRow, startCol, endRow, endCol, style) {
  eachCellInRect(sheet, startRow, startCol, endRow, endCol, cell => Object.assign(cell, style));
}

function addBorders(sheet, startRow, startCol, endRow, endCol, color = '777777', style = 'thin') {
  eachCellInRect(sheet, startRow, startCol, endRow, endCol, cell => {
    cell.border = {
      top: { style, color: { argb: 'FF' + color } },
      left: { style, color: { argb: 'FF' + color } },
      bottom: { style, color: { argb: 'FF' + color } },
      right: { style, color: { argb: 'FF' + color } }
    };
  });
}

function buildAttendanceWorkbook(ExcelJS, { month, groupName, leaderName, members, lessons, records, specialty = '', course = '' }) {
  const [year, monthNumber] = month.split('-').map(Number);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const academicStart = monthNumber >= 9 ? year : year - 1;
  const academicYear = academicStart + '-' + (academicStart + 1);
  const events = attendanceEvents(records, new Map(lessons.map(lesson => [lesson.id, lesson])));
  const knownMembers = members.map(member => ({
    id: member.id || member.userId,
    name: member.displayName || member.fullName || member.username || 'Участник'
  })).sort((a, b) => a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }));

  const memberById = new Map(knownMembers.map(member => [member.id, member]));
  const totals = new Map(knownMembers.map(member => [member.id, {
    total: 0, excused: 0, absent: 0, byDate: new Map()
  }]));

  events.forEach(event => {
    const summary = totals.get(event.studentId);
    if (!summary) return;

    summary.total += event.hours;
    if (event.reason === 'уважительно') summary.excused += event.hours;
    else summary.absent += event.hours;

    if (!summary.byDate.has(event.date)) summary.byDate.set(event.date, { lecture: 0, practice: 0 });
    const daySummary = summary.byDate.get(event.date);
    if (event.type === 'лекция') daySummary.lecture += event.hours;
    else daySummary.practice += event.hours;
  });

  const detailedRows = events
    .slice()
    .sort((a, b) =>
      (memberById.get(a.studentId)?.name || '').localeCompare(
        memberById.get(b.studentId)?.name || '', 'ru', { sensitivity: 'base' }
      ) || a.date.localeCompare(b.date) || a.subject.localeCompare(b.subject, 'ru')
    )
    .map(event => {
      const member = memberById.get(event.studentId);
      return [
        member?.name || 'Участник',
        dateLabel(event.date),
        event.type,
        event.subject,
        event.hours,
        event.pairs,
        event.reason
      ];
    });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'STUDIUM';
  workbook.subject = 'Месячный отчёт посещаемости';
  workbook.title = 'Ведомость посещаемости — ' + groupName + ' — ' + month;
  workbook.company = 'ОрГМУ';
  workbook.created = new Date();
  workbook.modified = new Date();

  const sheet = workbook.addWorksheet('Ведомость ' + month, {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 6 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
    properties: { defaultRowHeight: 18 }
  });

  for (let col = 1; col <= 36; col++) {
    sheet.getColumn(col).width = col === 1 ? 7 : col === 2 ? 34 : col <= 33 ? 4.5 : col === 34 ? 11 : 12;
  }

  sheet.mergeCells('A1:AJ1');
  sheet.getCell('A1').value = 'ВЕДОМОСТЬ УЧЕТА ПОСЕЩАЕМОСТИ ЛЕКЦИОННЫХ И ПРАКТИЧЕСКИХ ЗАНЯТИЙ';
  sheet.getCell('A1').font = { name: 'Arial', size: 12, bold: true };
  sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 27;

  sheet.mergeCells('A2:AJ2');
  sheet.getCell('A2').value = 'ОрГМУ';
  sheet.getCell('A2').font = { name: 'Arial', size: 10, bold: true };
  sheet.getCell('A2').alignment = { horizontal: 'center' };

  sheet.getCell('B3').value = 'Специальность';
  sheet.mergeCells('C3:F3');
  sheet.getCell('C3').value = specialty || ' ';
  sheet.getCell('N3').value = course || ' ';
  sheet.getCell('O3').value = 'курс';
  sheet.getCell('Q3').value = groupName;
  sheet.getCell('S3').value = 'группа';
  sheet.getCell('U3').value = 'за';
  sheet.getCell('V3').value = monthNames[monthNumber - 1];
  sheet.getCell('AC3').value = academicYear;
  ['B3','C3','N3','O3','Q3','S3','U3','V3','AC3'].forEach(ref => {
    sheet.getCell(ref).font = { name: 'Arial', size: 9 };
    sheet.getCell(ref).alignment = { vertical: 'middle', horizontal: 'left' };
  });

  sheet.mergeCells('A5:A6');
  sheet.mergeCells('B5:B6');
  sheet.mergeCells('C5:AG5');
  sheet.mergeCells('AH5:AH6');
  sheet.mergeCells('AI5:AJ5');
  sheet.getCell('A5').value = '№ п/п';
  sheet.getCell('B5').value = 'ФИО учащихся';
  sheet.getCell('C5').value = 'Числа месяца';
  sheet.getCell('AH5').value = 'Итого';
  sheet.getCell('AI5').value = 'Из них по причинам';
  for (let day = 1; day <= 31; day++) {
    sheet.getCell(6, day + 2).value = day <= daysInMonth ? day : '';
  }
  sheet.getCell('AI6').value = 'уваж.';
  sheet.getCell('AJ6').value = 'неуваж.';

  const headerStyle = {
    font: { name: 'Arial', size: 9, bold: true },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAEAEA' } },
    alignment: { horizontal: 'center', vertical: 'middle', wrapText: true }
  };
  styleRect(sheet, 5, 1, 6, 36, headerStyle);
  addBorders(sheet, 5, 1, 6, 36, '333333');
  sheet.getRow(5).height = 24;
  sheet.getRow(6).height = 22;

  const firstDataRow = 7;
  knownMembers.forEach((member, index) => {
    const rowNumber = firstDataRow + index;
    const summary = totals.get(member.id);
    sheet.getCell(rowNumber, 1).value = index + 1;
    sheet.getCell(rowNumber, 2).value = member.name;

    for (let day = 1; day <= 31; day++) {
      if (day > daysInMonth) continue;
      const iso = [year, String(monthNumber).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
      const value = summary.byDate.get(iso);
      if (!value) continue;
      if (value.lecture > 0 && value.practice > 0) {
        sheet.getCell(rowNumber, day + 2).value = value.lecture + '/' + value.practice;
      } else {
        sheet.getCell(rowNumber, day + 2).value = value.lecture || value.practice;
      }
    }

    sheet.getCell(rowNumber, 34).value = summary.total;
    sheet.getCell(rowNumber, 35).value = summary.excused || '';
    sheet.getCell(rowNumber, 36).value = summary.absent || '';
    sheet.getRow(rowNumber).height = 19;
  });

  const lastDataRow = Math.max(firstDataRow + knownMembers.length - 1, firstDataRow);
  styleRect(sheet, firstDataRow, 1, lastDataRow, 36, {
    font: { name: 'Arial', size: 9 },
    alignment: { vertical: 'middle', horizontal: 'center', wrapText: true }
  });
  styleRect(sheet, firstDataRow, 2, lastDataRow, 2, {
    alignment: { vertical: 'middle', horizontal: 'left', wrapText: true }
  });
  addBorders(sheet, firstDataRow, 1, lastDataRow, 36, '777777');
  styleRect(sheet, firstDataRow, 34, lastDataRow, 36, { font: { name: 'Arial', size: 9, bold: true } });

  const footerRow = lastDataRow + 2;
  sheet.mergeCells(footerRow, 2, footerRow, 10);
  sheet.getCell(footerRow, 2).value = 'Староста: ' + (leaderName || '________________');
  sheet.getCell(footerRow, 2).font = { name: 'Arial', size: 9 };
  sheet.mergeCells(footerRow + 2, 2, footerRow + 2, 36);
  sheet.getCell(footerRow + 2, 2).value = 'Примечание: указывается количество пропусков в часах (одна пара — 2 академических часа). Пропуски лекций и практических занятий через дробь, например 2/4: первая цифра — часы лекций, вторая — часы практических занятий.';
  sheet.getCell(footerRow + 2, 2).font = { name: 'Arial', size: 8, italic: true, color: { argb: 'FF555555' } };
  sheet.getCell(footerRow + 2, 2).alignment = { wrapText: true, vertical: 'middle' };
  sheet.getRow(footerRow + 2).height = 32;

  sheet.autoFilter = {
    from: { row: 6, column: 1 },
    to: { row: lastDataRow, column: 36 }
  };

  const detail = workbook.addWorksheet('Подробно', {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 18 }
  });
  detail.columns = [
    { header: 'ФИО', key: 'name', width: 34 },
    { header: 'Дата', key: 'date', width: 18 },
    { header: 'Вид занятия', key: 'type', width: 16 },
    { header: 'Предмет', key: 'subject', width: 34 },
    { header: 'Часы', key: 'hours', width: 10 },
    { header: 'Пар', key: 'pairs', width: 9 },
    { header: 'Причина', key: 'reason', width: 18 }
  ];
  detail.getRow(1).font = { name: 'Arial', size: 10, bold: true };
  detail.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAEAEA' } };
  detail.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
  detail.getRow(1).height = 23;
  detailedRows.forEach(row => detail.addRow(row));
  const detailLastRow = Math.max(detail.rowCount, 1);
  detail.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.font = { name: 'Arial', size: 9 };
    row.alignment = { vertical: 'middle' };
    row.getCell(5).alignment = { horizontal: 'center', vertical: 'middle' };
    row.getCell(6).alignment = { horizontal: 'center', vertical: 'middle' };
  });
  addBorders(detail, 1, 1, detailLastRow, 7, 'D4D4D4');
  detail.autoFilter = { from: 'A1', to: 'G' + detailLastRow };

  const note = detail.addRow(['', '', '', '', '', '', '']);
  note.height = 6;

  return workbook;
}

export async function downloadAttendanceReport({ month, groupName, leaderName, members, lessons, records, specialty = '', course = '' }) {
  const loaded = await import('exceljs');
  const ExcelJS = loaded.default || loaded;
  const workbook = buildAttendanceWorkbook(ExcelJS, {
    month, groupName, leaderName, members, lessons, records, specialty, course
  });
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const safeGroupName = String(groupName || 'group').replace(/[\/\\:*?"<>|]+/g, '-').replace(/\s+/g, '_');
  anchor.href = url;
  anchor.download = 'Явка_' + safeGroupName + '_' + month + '.xlsx';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  return { eventCount: attendanceEvents(records, new Map(lessons.map(lesson => [lesson.id, lesson]))).length };
}

