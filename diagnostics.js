(() => {
  'use strict';

  const EXPECTED_DIAGNOSTIC_VERSION = 'zakiya-diagnostics-v1';
  const EXPECTED_THREAD_ID = null;
  const DIAGNOSTIC_FUNCTION = 'diagnostics-zakiya';
  const config = window.APP_CONFIG || {};
  const student = config.student || {};
  const studentId = String(student.id || 'zakiya').trim().toLowerCase();
  const checksEl = document.getElementById('checks');
  const summaryEl = document.getElementById('main-summary');
  const rawEl = document.getElementById('raw-output');
  const configInfoEl = document.getElementById('config-info');
  const telegramInfoEl = document.getElementById('telegram-info');
  const dbWriteResultEl = document.getElementById('db-write-result');
  const sendResultEl = document.getElementById('send-result');
  const runAllBtn = document.getElementById('run-all');
  const dbWriteBtn = document.getElementById('test-db-write');
  const sendBtn = document.getElementById('send-test-report');
  let supabaseClient = null;
  let lastReport = { startedAt: null, checks: [], health: null, directRows: [], errors: [] };

  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  function addKV(target, key, value, mono = false) {
    target.insertAdjacentHTML('beforeend', `<div class="kv"><span>${esc(key)}</span><strong class="${mono ? 'mono' : ''}">${esc(value)}</strong></div>`);
  }

  function renderConfig() {
    configInfoEl.innerHTML = '';
    addKV(configInfoEl, 'student_id', studentId || '—', true);
    addKV(configInfoEl, 'Имя', student.nameRu || student.nameEn || '—');
    addKV(configInfoEl, 'Supabase URL', config.supabase?.url || 'не задан', true);
    addKV(configInfoEl, 'Public key', config.supabase?.anonKey ? 'есть' : 'НЕТ');
    addKV(configInfoEl, 'cloudSync', String(config.features?.cloudSync !== false));
    addKV(configInfoEl, 'telegramNotifications', String(config.features?.telegramNotifications !== false));
    addKV(configInfoEl, 'Ожидаемая Telegram-тема', 'NULL (без отдельной темы)', true);
    addKV(configInfoEl, 'Origin', window.location.origin, true);
  }

  function resetChecks() {
    checksEl.innerHTML = '';
    lastReport = { startedAt: new Date().toISOString(), checks: [], health: null, directRows: [], errors: [] };
  }

  function addCheck(name, status, detail) {
    const icon = status === 'ok' ? '✓' : status === 'bad' ? '!' : status === 'warn' ? '!' : '…';
    checksEl.insertAdjacentHTML('beforeend', `<div class="check ${status}"><div class="ico">${icon}</div><div><div class="name">${esc(name)}</div><div class="detail">${esc(detail || '')}</div></div></div>`);
    lastReport.checks.push({ name, status, detail: detail || '' });
  }

  function setSummary(status, text) {
    summaryEl.className = `summary ${status || ''}`.trim();
    summaryEl.textContent = text;
  }

  function getClient() {
    if (supabaseClient) return supabaseClient;
    if (!window.supabase?.createClient) throw new Error('Supabase JS SDK не загрузился');
    const url = String(config.supabase?.url || '').trim();
    const anonKey = String(config.supabase?.anonKey || '').trim();
    if (!url || !anonKey) throw new Error('В config.js отсутствуют supabase.url или supabase.anonKey');
    supabaseClient = window.supabase.createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    return supabaseClient;
  }

  function functionUrl() {
    const base = String(config.supabase?.url || '').replace(/\/+$/, '');
    return `${base}/functions/v1/${DIAGNOSTIC_FUNCTION}`;
  }

  async function invokeDiagnostic(body) {
    const anonKey = String(config.supabase?.anonKey || '').trim();
    const response = await fetch(functionUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'apikey': anonKey,
        'authorization': `Bearer ${anonKey}`
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { ok: response.ok, status: response.status, data };
  }

  function explainFunctionFailure(result) {
    const message = String(result?.data?.error || result?.data?.message || result?.data?.raw || '').trim();
    if (result?.status === 404) return `Edge Function ${DIAGNOSTIC_FUNCTION} не найдена или не задеплоена.`;
    if (result?.status === 401) return message || 'Edge Function отклонила публичный ключ сайта.';
    if (result?.status === 403) return message || 'Диагностика запрещена для этого student_id.';
    if (!result?.status) return 'Браузер не смог вызвать Edge Function: проверь сеть, URL проекта и CORS.';
    return `HTTP ${result?.status || '—'}${message ? `: ${message}` : ''}`;
  }

  function formatError(error) {
    if (!error) return 'Неизвестная ошибка';
    const code = error.code ? `${error.code}: ` : '';
    const message = error.message || error.error_description || String(error);
    if (/row-level security|permission denied|42501/i.test(message)) return `${code}${message}. Ошибка прав доступа / RLS Supabase.`;
    return `${code}${message}`;
  }

  async function runAll() {
    runAllBtn.disabled = true;
    resetChecks();
    setSummary('', 'Проверяю подключения…');
    telegramInfoEl.innerHTML = '';

    try {
      const hasConfig = Boolean(config.supabase?.url && config.supabase?.anonKey && studentId === 'zakiya');
      addCheck('1. config.js', hasConfig ? 'ok' : 'bad', hasConfig ? 'Конфигурация загружена для zakiya.' : 'Ожидается student_id=zakiya и заполненные Supabase URL / public key.');
      if (!hasConfig) throw new Error('Некорректный config.js');

      const sdkOk = Boolean(window.supabase?.createClient);
      addCheck('2. Supabase JS SDK', sdkOk ? 'ok' : 'bad', sdkOk ? 'Библиотека @supabase/supabase-js загружена.' : 'CDN Supabase JS не загрузился.');
      if (!sdkOk) throw new Error('Supabase SDK не загрузился');

      const client = getClient();
      const homeworkTable = config.supabase?.tables?.homework || 'homework_progress';
      const readResponse = await client
        .from(homeworkTable)
        .select('student_id,lesson_id,lesson_title,status,checked_at,submitted_at,updated_at,score_correct,score_total,score_percent,answers,report_status')
        .eq('student_id', studentId)
        .order('lesson_id', { ascending: false })
        .limit(100);

      if (readResponse.error) {
        const detail = formatError(readResponse.error);
        addCheck('3. Supabase Database / чтение homework_progress', 'bad', detail);
        lastReport.errors.push({ stage: 'database_read', error: detail });
      } else {
        lastReport.directRows = readResponse.data || [];
        addCheck('3. Supabase Database / чтение homework_progress', 'ok', `Доступ есть. Получено строк: ${(readResponse.data || []).length}.`);
      }

      let edgeResult;
      try { edgeResult = await invokeDiagnostic({ kind: 'diagnostics_health', studentId }); }
      catch (error) { edgeResult = { ok: false, status: 0, data: { error: error.message || String(error) } }; }

      if (!edgeResult.ok || edgeResult.data?.diagnosticVersion !== EXPECTED_DIAGNOSTIC_VERSION) {
        const detail = edgeResult.ok
          ? `Функция отвечает, но версия диагностики другая: ${edgeResult.data?.diagnosticVersion || 'не указана'}.`
          : explainFunctionFailure(edgeResult);
        addCheck(`4. Edge Function ${DIAGNOSTIC_FUNCTION}`, 'bad', detail);
        lastReport.errors.push({ stage: 'edge_function', error: detail, response: edgeResult });
      } else {
        lastReport.health = edgeResult.data;
        addCheck(`4. Edge Function ${DIAGNOSTIC_FUNCTION}`, 'ok', `Задеплоена нужная версия: ${edgeResult.data.diagnosticVersion}.`);

        const h = edgeResult.data;
        const browserRows = Array.isArray(lastReport.directRows)
          ? lastReport.directRows.filter((row) => !String(row.lesson_id || '').startsWith('__diagnostic_probe__')).length
          : 0;
        const serviceRows = Number(h.database?.homeworkRows || 0);
        const visibilityOk = !readResponse.error && browserRows === serviceRows;
        addCheck('5. RLS / одинаковое чтение browser и service role', visibilityOk ? 'ok' : 'bad', visibilityOk
          ? `Браузер и сервер видят одинаковое количество рабочих строк ДЗ: ${serviceRows}.`
          : `Браузер видит ${browserRows}, сервер видит ${serviceRows}. Проверь SELECT policy для student_id=${studentId}.`);

        addCheck('6. Edge Function → Supabase', h.database?.ok ? 'ok' : 'bad', h.database?.ok ? `Сервер читает Supabase. Строк ДЗ: ${h.database.homeworkRows}.` : (h.database?.error || 'Сервер не может читать Supabase.'));
        addCheck('7. Получатель Telegram', h.recipient?.ok ? 'ok' : 'bad', h.recipient?.ok ? 'Получатель найден и включён.' : (h.recipient?.error || 'Получатель не найден/выключен.'));

        const actualThread = h.recipient?.threadId ?? null;
        const threadOk = h.recipient?.ok && actualThread === EXPECTED_THREAD_ID;
        addCheck('8. Тема Telegram', threadOk ? 'ok' : 'bad', h.recipient?.ok ? `message_thread_id=${actualThread === null ? 'NULL' : actualThread}; ожидается NULL.` : 'Нельзя проверить тему без получателя.');
        addCheck('9. Telegram Bot API / бот', h.telegram?.bot?.ok ? 'ok' : 'bad', h.telegram?.bot?.ok ? `Telegram видит бота @${h.telegram.bot.username || 'без username'}.` : (h.telegram?.bot?.error || 'getMe завершился ошибкой.'));
        addCheck('10. Telegram Bot API / чат', h.telegram?.chat?.ok ? 'ok' : 'bad', h.telegram?.chat?.ok ? `Бот имеет доступ к целевому чату (${h.telegram.chat.type || 'chat'}).` : (h.telegram?.chat?.error || 'Бот не имеет доступа к целевому чату.'));

        const suspicious = Array.isArray(h.database?.suspiciousHomework) ? h.database.suspiciousHomework : [];
        addCheck('11. Состояние сохранённых ДЗ', suspicious.length ? 'warn' : 'ok', suspicious.length
          ? `Есть записи с неожиданным сочетанием status/report_status: ${suspicious.join(', ')}.`
          : 'Состояния сохранённых рабочих ДЗ выглядят корректно.');

        telegramInfoEl.innerHTML = '';
        addKV(telegramInfoEl, 'Diagnostic version', h.diagnosticVersion || '—', true);
        addKV(telegramInfoEl, 'Recipient', h.recipient?.ok ? 'найден' : 'ошибка');
        addKV(telegramInfoEl, 'Enabled', String(Boolean(h.recipient?.enabled)));
        addKV(telegramInfoEl, 'message_thread_id', actualThread === null ? 'NULL' : actualThread, true);
        addKV(telegramInfoEl, 'Bot API', h.telegram?.bot?.ok ? 'OK' : 'ERROR');
        addKV(telegramInfoEl, 'Доступ к чату', h.telegram?.chat?.ok ? 'OK' : 'ERROR');
      }

      const bad = lastReport.checks.filter((item) => item.status === 'bad');
      const warn = lastReport.checks.filter((item) => item.status === 'warn');
      if (bad.length) setSummary('bad', `Найдена проблема: ${bad[0].name}. Смотри первую красную строку выше.`);
      else if (warn.length) setSummary('warn', 'Основные подключения работают, но есть предупреждение по сохранённым данным.');
      else setSummary('ok', 'Все проверенные подключения работают. Можно отдельно проверить запись Supabase и тестовое Telegram-сообщение.');
    } catch (error) {
      const detail = formatError(error);
      addCheck('Проверка остановлена', 'bad', detail);
      lastReport.errors.push({ stage: 'fatal', error: detail });
      setSummary('bad', detail);
    } finally {
      lastReport.finishedAt = new Date().toISOString();
      rawEl.textContent = JSON.stringify(lastReport, null, 2);
      runAllBtn.disabled = false;
    }
  }

  async function bestEffortDeleteProbe(client, table, probeId) {
    try { await client.from(table).delete().eq('student_id', studentId).eq('lesson_id', probeId); } catch {}
  }

  async function testDatabaseWrite() {
    dbWriteBtn.disabled = true;
    dbWriteResultEl.innerHTML = '<div class="summary">Проверяю запись homework_progress…</div>';
    const client = getClient();
    const table = config.supabase?.tables?.homework || 'homework_progress';
    const probeId = `__diagnostic_probe__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      const { error: insertError } = await client.from(table).insert({
        student_id: studentId,
        student_name: student.nameRu || student.nameEn || studentId,
        lesson_id: probeId,
        lesson_title: 'Diagnostics homework write probe',
        status: 'draft',
        answers: {},
        legacy_answers: null,
        migrated_from_legacy: false,
        score_correct: null,
        score_total: null,
        score_percent: null,
        checked_at: null,
        submitted_at: null,
        locked_at: null,
        report_status: 'not_sent',
        report_sent_at: null,
        report_error: null
      });
      if (insertError) throw new Error(`browser_draft_insert: ${formatError(insertError)}`);

      const probe = await invokeDiagnostic({ kind: 'diagnostics_homework_probe', studentId, lessonId: probeId });
      if (!probe.ok || !probe.data?.ok) throw new Error(probe.data?.error || explainFunctionFailure(probe));

      dbWriteResultEl.innerHTML = '<div class="summary ok">✓ Путь homework_progress работает: browser draft → submitted_pending_report → submitted → cleanup. Реальные ДЗ не изменялись.</div>';
      lastReport.databaseWriteProbe = { ok: true, lessonId: probeId, stages: probe.data.stages || null };
    } catch (error) {
      const detail = formatError(error);
      dbWriteResultEl.innerHTML = `<div class="summary bad">✕ Ошибка пути homework_progress: ${esc(detail)}</div>`;
      lastReport.errors.push({ stage: 'database_write_probe', error: detail, lessonId: probeId });
      try { await invokeDiagnostic({ kind: 'diagnostics_cleanup_probe', studentId, lessonId: probeId }); } catch {}
      await bestEffortDeleteProbe(client, table, probeId);
    } finally {
      rawEl.textContent = JSON.stringify(lastReport, null, 2);
      dbWriteBtn.disabled = false;
    }
  }

  async function sendTestReport() {
    sendBtn.disabled = true;
    sendResultEl.innerHTML = '<div class="summary">Отправляю тестовое Telegram-сообщение…</div>';
    try {
      const result = await invokeDiagnostic({ kind: 'diagnostics_send_report', studentId, pageUrl: window.location.href });
      if (!result.ok || !result.data?.ok) {
        const retry = result.data?.retryAfterSeconds ? ` Повтори через ${result.data.retryAfterSeconds} сек.` : '';
        throw new Error(`${result.data?.error || explainFunctionFailure(result)}${retry}`);
      }
      if (result.data.skipped) {
        const retry = Number(result.data.retryAfterSeconds || 30);
        sendResultEl.innerHTML = `<div class="summary warn">Тест уже отправлялся недавно. Повтори примерно через ${retry} сек.</div>`;
      } else {
        sendResultEl.innerHTML = `<div class="summary ok">✓ Telegram принял тестовое сообщение. message_id=${esc(result.data.telegramMessageId)}; thread_id=${esc(result.data.threadId ?? 'NULL')}.</div>`;
      }
      lastReport.telegramSendProbe = result.data || null;
    } catch (error) {
      const detail = formatError(error);
      sendResultEl.innerHTML = `<div class="summary bad">✕ Тестовое сообщение не отправлено: ${esc(detail)}</div>`;
      lastReport.errors.push({ stage: 'telegram_test_send', error: detail });
    } finally {
      rawEl.textContent = JSON.stringify(lastReport, null, 2);
      sendBtn.disabled = false;
    }
  }

  async function copyReport() {
    const reportText = rawEl.textContent || '';
    try {
      await navigator.clipboard.writeText(reportText);
      const button = document.getElementById('copy-report');
      const old = button.textContent;
      button.textContent = 'Скопировано ✓';
      setTimeout(() => { button.textContent = old; }, 1300);
    } catch { window.prompt('Скопируй отчёт вручную:', reportText); }
  }

  runAllBtn.addEventListener('click', runAll);
  dbWriteBtn.addEventListener('click', testDatabaseWrite);
  sendBtn.addEventListener('click', sendTestReport);
  document.getElementById('copy-report').addEventListener('click', copyReport);
  document.getElementById('reload-page').addEventListener('click', () => window.location.reload());
  renderConfig();
})();
