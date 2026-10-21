import { withSupabase } from 'npm:@supabase/server'

const encoder = new TextEncoder()

const FUNCTION_VERSION = 'homework-reports-v10-multi-bot-routing'
const DIAGNOSTIC_VERSION = 'multi-student-diagnostics-v1'
const DIAGNOSTIC_COOLDOWN_MS = 30_000
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-notify-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function diagnosticJson(body: unknown, status = 200): Response {
  const responseBody = body && typeof body === 'object' && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>), functionVersion: FUNCTION_VERSION }
    : body
  return Response.json(responseBody, { status, headers: corsHeaders })
}


function secureEqual(left: string, right: string): boolean {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  if (a.length !== b.length) return false

  let diff = 0
  for (let index = 0; index < a.length; index += 1) {
    diff |= a[index] ^ b[index]
  }
  return diff === 0
}

function parseKeyDictionary(raw: string | undefined | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    return Object.values(parsed).filter((value): value is string => typeof value === 'string' && value.length > 0)
  } catch {
    return []
  }
}

function publicClientAuthorized(req: Request): boolean {
  const apiKey = (req.headers.get('apikey') ?? '').trim()
  if (!apiKey) return false

  const allowedKeys = [
    Deno.env.get('SITE_PUBLIC_API_KEY') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    ...parseKeyDictionary(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')),
  ].filter(Boolean)

  return allowedKeys.some((key) => secureEqual(apiKey, key))
}

function normalizeStudentId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized) ? normalized : null
}

function telegramBotTokenForStudent(studentId: string): string {
  const dedicatedToken = studentId === 'marina'
    ? Deno.env.get('TELEGRAM_BOT_TOKEN_MARINA')
    : Deno.env.get('TELEGRAM_BOT_TOKEN_COMMON')

  return dedicatedToken || Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
}

function notifyWebhookSecretForStudent(studentId: string): string {
  const dedicatedSecret = studentId === 'marina'
    ? Deno.env.get('NOTIFY_WEBHOOK_SECRET_MARINA')
    : Deno.env.get('NOTIFY_WEBHOOK_SECRET_COMMON')

  return dedicatedSecret || Deno.env.get('NOTIFY_WEBHOOK_SECRET') || ''
}

function escapeTelegramHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1))}…`
}

function formatHomeworkAnswers(answers: unknown, limit = 2500): string {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return '—'
  const lines: string[] = []
  let used = 0
  for (const [taskId, value] of Object.entries(answers as Record<string, unknown>)) {
    let rendered: string
    try {
      rendered = typeof value === 'string' ? value : JSON.stringify(value)
    } catch {
      rendered = String(value)
    }
    rendered = truncateText(rendered || '—', 700)
    const line = `<code>${escapeTelegramHtml(taskId)}</code>: ${escapeTelegramHtml(rendered)}`
    if (used + line.length > limit) {
      lines.push('… остальные ответы сохранены в Supabase')
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return lines.length ? lines.join('\n') : '—'
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function parseTelegramId(value: string | undefined | null): number | null {
  const normalized = String(value ?? '').trim()
  if (!/^-?\d+$/.test(normalized)) return null

  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function stableChoice(seed: string, size: number): number {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash * 31) + seed.charCodeAt(index)) >>> 0
  }
  return size > 0 ? hash % size : 0
}

function buildMotivation(seed: string): string {
  const variants = [
    'Good luck! ⭐',
    'You can do it! 💪',
    "You've got this! 🌟",
    'Take your time and do your best! ✨',
    'Enjoy the lesson! 📚',
  ]
  return variants[stableChoice(seed, variants.length)]
}

function buildMessage(
  hasVocabulary: boolean,
  hasGrammar: boolean,
  homeworkTitle: unknown,
  seed: string,
): string {
  const title = escapeTelegramHtml(homeworkTitle || 'English homework')
  const motivation = buildMotivation(seed)

  const steps: string[] = []
  if (hasVocabulary) steps.push('First, learn the new words.')
  if (hasGrammar) steps.push(hasVocabulary ? 'Review the grammar.' : 'First, review the grammar.')
  if (hasVocabulary || hasGrammar) steps.push('Then, do the homework.')
  else steps.push('Open the homework and complete the tasks.')

  return [
    'Hi there! 👋',
    '',
    'Your new English homework is ready.',
    '',
    `📘 <b>${title}</b>`,
    '',
    ...steps,
    '',
    motivation,
  ].join('\n')
}

async function sendTelegramMessage(
  token: string,
  chatId: number,
  messageThreadId: number | null,
  text: string,
  inlineKeyboard: Array<Array<{ text: string; url: string }>>,
) {
  const requestBody: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  }

  if (inlineKeyboard.length) requestBody.reply_markup = { inline_keyboard: inlineKeyboard }
  if (messageThreadId) requestBody.message_thread_id = messageThreadId

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  })

  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.ok) {
    const description = result?.description || `Telegram HTTP ${response.status}`
    throw new Error(description)
  }

  return result.result
}


async function telegramApi(token: string, method: string, body?: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.ok) {
    return { ok: false, error: result?.description || `Telegram HTTP ${response.status}` }
  }
  return { ok: true, result: result.result }
}

async function resolveRecipient(ctx: any, studentId: string) {
  const { data: recipient, error } = await ctx.supabaseAdmin
    .from('telegram_recipients')
    .select('chat_id, message_thread_id, enabled')
    .eq('student_id', studentId)
    .maybeSingle()

  if (error) return { ok: false, error: error.message, enabled: false, source: 'database', chatId: null, threadId: null }
  if (recipient && !recipient.enabled) {
    return { ok: false, error: 'Telegram recipient is explicitly disabled', enabled: false, source: 'database', chatId: null, threadId: null }
  }

  const fallbackChatId = parseTelegramId(Deno.env.get('TEACHER_CHAT_ID'))
  const chatId = recipient ? parseTelegramId(recipient.chat_id) : fallbackChatId
  const threadId = recipient ? parseTelegramId(recipient.message_thread_id) : null
  const source = recipient ? 'database' : 'github_actions_secret'

  if (!Number.isSafeInteger(chatId)) {
    return {
      ok: false,
      error: 'Telegram recipient is missing: configure telegram_recipients or TEACHER_CHAT_ID and redeploy secrets.',
      enabled: false,
      source,
      chatId: null,
      threadId,
    }
  }

  return { ok: true, enabled: true, source, chatId, threadId }
}

function diagnosticRequestAuthorized(req: Request): boolean {
  return publicClientAuthorized(req)
}

function homeworkStateSuspicious(row: any): boolean {
  const status = String(row?.status || '')
  const report = String(row?.report_status || '')
  if (status === 'draft') return report !== 'not_sent'
  if (status === 'submitted_pending_report') return !['pending', 'failed'].includes(report)
  if (status === 'submitted') return report !== 'sent'
  return true
}

async function handleHomeworkReport(req: Request, ctx: any, payload: any): Promise<Response> {
  if (!publicClientAuthorized(req)) {
    return diagnosticJson({ ok: false, error: 'Unauthorized homework report request' }, 401)
  }

  const studentId = normalizeStudentId(payload?.studentId)
  const lessonId = typeof payload?.lessonId === 'string' ? payload.lessonId.trim() : ''
  if (!studentId || !/^lesson-\d+$/.test(lessonId)) {
    return diagnosticJson({ ok: false, error: 'Invalid homework report identity' }, 400)
  }

  const homeworkTable = 'homework_progress'
  const { data: row, error: rowError } = await ctx.supabaseAdmin
    .from(homeworkTable)
    .select('student_id,student_name,lesson_id,lesson_title,status,report_status,score_correct,score_total,score_percent,answers,submitted_at,report_sent_at')
    .eq('student_id', studentId)
    .eq('lesson_id', lessonId)
    .maybeSingle()

  if (rowError) return diagnosticJson({ ok: false, error: rowError.message }, 500)
  if (!row) return diagnosticJson({ ok: false, error: 'Homework row was not found' }, 404)

  if (row.status === 'submitted' && row.report_status === 'sent') {
    return diagnosticJson({ ok: true, skipped: true, reason: 'already_sent', reportSentAt: row.report_sent_at || null })
  }

  if (row.status !== 'submitted_pending_report' || !['pending', 'failed'].includes(String(row.report_status || ''))) {
    return diagnosticJson({
      ok: false,
      error: `Homework is not ready for a report: ${row.status}/${row.report_status}`,
    }, 409)
  }

  const botToken = telegramBotTokenForStudent(studentId)
  if (!botToken) return diagnosticJson({ ok: false, error: 'Telegram bot token is not configured for this student' }, 500)

  const recipient = await resolveRecipient(ctx, studentId)
  if (!recipient.ok || !Number.isSafeInteger(recipient.chatId)) {
    return diagnosticJson({ ok: false, error: recipient.error || 'Telegram recipient is not configured' }, 500)
  }

  const publicationIdentity = {
    student_id: studentId,
    material_type: 'homework_report',
    material_id: lessonId,
    notification_version: 1,
  }

  const { data: existing, error: existingError } = await ctx.supabaseAdmin
    .from('material_publications')
    .select('id,status,telegram_message_id,created_at,updated_at,sent_at,error_message')
    .eq('student_id', studentId)
    .eq('material_type', 'homework_report')
    .eq('material_id', lessonId)
    .eq('notification_version', 1)
    .maybeSingle()

  if (existingError) return diagnosticJson({ ok: false, error: existingError.message }, 500)

  if (existing?.status === 'sent') {
    const reportSentAt = existing.sent_at || new Date().toISOString()
    const { error: reconcileError } = await ctx.supabaseAdmin
      .from(homeworkTable)
      .update({ status: 'submitted', report_status: 'sent', report_sent_at: reportSentAt, report_error: null })
      .eq('student_id', studentId)
      .eq('lesson_id', lessonId)
    if (reconcileError) return diagnosticJson({ ok: false, error: `Report was sent earlier, but homework state could not be reconciled: ${reconcileError.message}` }, 500)
    return diagnosticJson({ ok: true, skipped: true, reason: 'already_sent', telegramMessageId: existing.telegram_message_id, reportSentAt })
  }

  let publicationId = existing?.id as string | undefined
  if (publicationId) {
    const lastChanged = Date.parse(existing.updated_at || existing.created_at || '')
    const isFreshPending = existing.status === 'pending' && Number.isFinite(lastChanged) && Date.now() - lastChanged < 120_000
    if (isFreshPending) {
      return diagnosticJson({ ok: true, skipped: true, reason: 'already_in_progress' })
    }
    const { error } = await ctx.supabaseAdmin
      .from('material_publications')
      .update({ status: 'pending', payload: { kind: 'homework_submit_report', lessonId }, error_message: null })
      .eq('id', publicationId)
    if (error) return diagnosticJson({ ok: false, error: error.message }, 500)
  } else {
    const { data: created, error } = await ctx.supabaseAdmin
      .from('material_publications')
      .insert({ ...publicationIdentity, status: 'pending', payload: { kind: 'homework_submit_report', lessonId } })
      .select('id')
      .single()
    if (error) {
      // A concurrent request may have created the idempotency row first.
      if (String(error.code || '') === '23505') {
        return diagnosticJson({ ok: true, skipped: true, reason: 'already_in_progress' })
      }
      return diagnosticJson({ ok: false, error: error.message }, 500)
    }
    publicationId = created.id
  }

  const scoreText = Number.isFinite(Number(row.score_total)) && Number(row.score_total) > 0
    ? `${Number(row.score_correct || 0)}/${Number(row.score_total)} (${Number(row.score_percent || 0)}%)`
    : 'проверяет преподаватель'
  const storedLessonTitle = String(row.lesson_title || '').trim()
  const requestedLessonTitle = typeof payload?.lessonTitle === 'string' ? payload.lessonTitle.trim() : ''
  const lessonTitle = storedLessonTitle && storedLessonTitle !== lessonId
    ? storedLessonTitle
    : (requestedLessonTitle || storedLessonTitle || lessonId)

  let homeworkUrl = isHttpUrl(payload?.homeworkUrl) ? payload.homeworkUrl : null
  let resultUrl = isHttpUrl(payload?.resultUrl) ? payload.resultUrl : null
  if (!homeworkUrl || !resultUrl) {
    const siteBaseUrl = String(Deno.env.get('SITE_BASE_URL') || '').trim().replace(/\/+$/, '')
    if (isHttpUrl(siteBaseUrl)) {
      const target = new URL(`lesson.html?id=${encodeURIComponent(lessonId)}`, `${siteBaseUrl}/`)
      if (!homeworkUrl) homeworkUrl = target.toString()
      if (!resultUrl) {
        target.hash = 'lesson-result'
        resultUrl = target.toString()
      }
    }
  }
  if (homeworkUrl && !resultUrl) {
    const target = new URL(homeworkUrl)
    target.hash = 'lesson-result'
    resultUrl = target.toString()
  }
  if (resultUrl && !homeworkUrl) {
    const target = new URL(resultUrl)
    target.hash = ''
    homeworkUrl = target.toString()
  }

  const text = [
    '✅ <b>Homework completed</b>',
    '',
    `📘 <b>${escapeTelegramHtml(lessonTitle)}</b>`,
    `📊 <b>Result:</b> ${escapeTelegramHtml(scoreText)}`,
    '',
    'Open it on the site to see the answers and mistakes.',
  ].join('\n')

  const keyboard: Array<Array<{ text: string; url: string }>> = []
  if (homeworkUrl) keyboard.push([{ text: '📝 Open homework', url: homeworkUrl }])
  if (resultUrl) keyboard.push([{ text: '📊 View results', url: resultUrl }])

  try {
    const message = await sendTelegramMessage(botToken, recipient.chatId as number, recipient.threadId, text, keyboard)
    const reportSentAt = new Date().toISOString()

    const { error: publicationUpdateError } = await ctx.supabaseAdmin
      .from('material_publications')
      .update({ status: 'sent', telegram_message_id: message.message_id, sent_at: reportSentAt, error_message: null })
      .eq('id', publicationId)
    if (publicationUpdateError) throw new Error(`Telegram sent, but publication state update failed: ${publicationUpdateError.message}`)

    const { error: homeworkUpdateError } = await ctx.supabaseAdmin
      .from(homeworkTable)
      .update({ status: 'submitted', report_status: 'sent', report_sent_at: reportSentAt, report_error: null })
      .eq('student_id', studentId)
      .eq('lesson_id', lessonId)
    if (homeworkUpdateError) {
      return diagnosticJson({
        ok: false,
        sent: true,
        telegramMessageId: message.message_id,
        error: `Telegram report was sent, but homework state update failed: ${homeworkUpdateError.message}`,
      }, 500)
    }

    return diagnosticJson({
      ok: true,
      sent: true,
      telegramMessageId: message.message_id,
      threadId: recipient.threadId,
      reportSentAt,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (publicationId) {
      await ctx.supabaseAdmin
        .from('material_publications')
        .update({ status: 'failed', error_message: message })
        .eq('id', publicationId)
    }
    await ctx.supabaseAdmin
      .from(homeworkTable)
      .update({ status: 'submitted_pending_report', report_status: 'failed', report_sent_at: null, report_error: message })
      .eq('student_id', studentId)
      .eq('lesson_id', lessonId)
    return diagnosticJson({ ok: false, error: message }, 502)
  }
}

async function handleDiagnostics(req: Request, ctx: any, payload: any): Promise<Response> {
  if (!diagnosticRequestAuthorized(req)) {
    return diagnosticJson({ ok: false, error: 'Unauthorized diagnostics request', diagnosticVersion: DIAGNOSTIC_VERSION }, 401)
  }

  const studentId = normalizeStudentId(payload?.studentId)
  if (!studentId) {
    return diagnosticJson({ ok: false, error: 'Invalid diagnostics student_id' }, 400)
  }

  const kind = String(payload?.kind || '')
  const homeworkTable = 'homework_progress'

  if (kind === 'diagnostics_cleanup_probe') {
    const lessonId = String(payload?.lessonId || '')
    if (!lessonId.startsWith('__diagnostic_probe__')) {
      return diagnosticJson({ ok: false, error: 'Invalid diagnostics lesson id' }, 400)
    }
    const { error } = await ctx.supabaseAdmin
      .from(homeworkTable)
      .delete()
      .eq('student_id', studentId)
      .eq('lesson_id', lessonId)
    return error
      ? diagnosticJson({ ok: false, error: error.message }, 500)
      : diagnosticJson({ ok: true, cleaned: true })
  }

  if (kind === 'diagnostics_homework_probe') {
    const lessonId = String(payload?.lessonId || '')
    if (!lessonId.startsWith('__diagnostic_probe__')) {
      return diagnosticJson({ ok: false, error: 'Invalid diagnostics lesson id' }, 400)
    }

    const stages: Record<string, unknown> = {}
    try {
      const { data: draft, error: draftError } = await ctx.supabaseAdmin
        .from(homeworkTable)
        .select('student_id,lesson_id,status,report_status')
        .eq('student_id', studentId)
        .eq('lesson_id', lessonId)
        .maybeSingle()
      if (draftError) throw new Error(`service_read_draft: ${draftError.message}`)
      if (!draft) throw new Error('service_read_draft: browser draft was not found')
      if (draft.status !== 'draft' || draft.report_status !== 'not_sent') {
        throw new Error(`service_read_draft: unexpected state ${draft.status}/${draft.report_status}`)
      }
      stages.browserDraft = 'ok'

      const submittedAt = new Date().toISOString()
      const { error: pendingError } = await ctx.supabaseAdmin
        .from(homeworkTable)
        .update({
          status: 'submitted_pending_report',
          submitted_at: submittedAt,
          locked_at: submittedAt,
          report_status: 'pending',
          report_sent_at: null,
          report_error: null,
        })
        .eq('student_id', studentId)
        .eq('lesson_id', lessonId)
      if (pendingError) throw new Error(`pending_transition: ${pendingError.message}`)
      stages.pendingTransition = 'ok'

      const reportSentAt = new Date().toISOString()
      const { error: submittedError } = await ctx.supabaseAdmin
        .from(homeworkTable)
        .update({
          status: 'submitted',
          report_status: 'sent',
          report_sent_at: reportSentAt,
          report_error: null,
        })
        .eq('student_id', studentId)
        .eq('lesson_id', lessonId)
      if (submittedError) throw new Error(`submitted_transition: ${submittedError.message}`)
      stages.submittedTransition = 'ok'

      const { error: cleanupError } = await ctx.supabaseAdmin
        .from(homeworkTable)
        .delete()
        .eq('student_id', studentId)
        .eq('lesson_id', lessonId)
      if (cleanupError) throw new Error(`cleanup: ${cleanupError.message}`)
      stages.cleanup = 'ok'

      return diagnosticJson({ ok: true, diagnosticVersion: DIAGNOSTIC_VERSION, stages })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const { error: cleanupError } = await ctx.supabaseAdmin
        .from(homeworkTable)
        .delete()
        .eq('student_id', studentId)
        .eq('lesson_id', lessonId)
      if (cleanupError) stages.cleanupError = cleanupError.message
      return diagnosticJson({ ok: false, error: message, stages }, 500)
    }
  }

  const botToken = telegramBotTokenForStudent(studentId)
  const recipient = await resolveRecipient(ctx, studentId)

  if (kind === 'diagnostics_send_report') {
    if (!botToken) return diagnosticJson({ ok: false, error: 'Telegram bot token is not configured for this student' }, 500)
    if (!recipient.ok || !Number.isSafeInteger(recipient.chatId)) {
      return diagnosticJson({ ok: false, error: recipient.error || 'Telegram recipient is not configured' }, 500)
    }

    const cutoff = new Date(Date.now() - DIAGNOSTIC_COOLDOWN_MS).toISOString()
    const { data: recent, error: recentError } = await ctx.supabaseAdmin
      .from('material_publications')
      .select('created_at')
      .eq('student_id', studentId)
      .eq('material_type', 'diagnostic')
      .eq('material_id', 'telegram-test')
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (recentError) return diagnosticJson({ ok: false, error: recentError.message }, 500)
    if (recent?.created_at) {
      const elapsed = Date.now() - Date.parse(recent.created_at)
      const retryAfterSeconds = Math.max(1, Math.ceil((DIAGNOSTIC_COOLDOWN_MS - elapsed) / 1000))
      return diagnosticJson({ ok: true, skipped: true, retryAfterSeconds, threadId: recipient.threadId })
    }

    const notificationVersion = Math.max(1, Math.floor(Date.now() / 1000))
    const logPayload = { kind, pageUrl: isHttpUrl(payload?.pageUrl) ? payload.pageUrl : null }
    const { data: publication, error: publicationError } = await ctx.supabaseAdmin
      .from('material_publications')
      .insert({
        student_id: studentId,
        material_type: 'diagnostic',
        material_id: 'telegram-test',
        notification_version: notificationVersion,
        status: 'pending',
        payload: logPayload,
      })
      .select('id')
      .single()
    if (publicationError) return diagnosticJson({ ok: false, error: publicationError.message }, 500)

    try {
      const text = [
        '🧪 <b>Тест диагностики English Space</b>',
        '',
        `<code>student_id=${escapeTelegramHtml(studentId)}</code>: браузер → Supabase → Edge Function → Telegram работает.`,
        '',
        'Это служебное тестовое сообщение. Домашние работы и прогресс не изменялись.',
      ].join('\n')
      const message = await sendTelegramMessage(botToken, recipient.chatId as number, recipient.threadId, text, [])
      await ctx.supabaseAdmin
        .from('material_publications')
        .update({ status: 'sent', telegram_message_id: message.message_id, sent_at: new Date().toISOString(), error_message: null })
        .eq('id', publication.id)
      return diagnosticJson({
        ok: true,
        skipped: false,
        diagnosticVersion: DIAGNOSTIC_VERSION,
        telegramMessageId: message.message_id,
        threadId: recipient.threadId,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await ctx.supabaseAdmin
        .from('material_publications')
        .update({ status: 'failed', error_message: message })
        .eq('id', publication.id)
      return diagnosticJson({ ok: false, error: message }, 502)
    }
  }

  if (kind !== 'diagnostics_health') {
    return diagnosticJson({ ok: false, error: 'Unknown diagnostics request' }, 400)
  }

  const { data: homeworkRows, error: homeworkError } = await ctx.supabaseAdmin
    .from(homeworkTable)
    .select('lesson_id,status,report_status,migrated_from_legacy,submitted_at')
    .eq('student_id', studentId)

  const rawRows = homeworkRows || []
  const staleProbeIds = rawRows
    .map((row: any) => String(row?.lesson_id || ''))
    .filter((lessonId: string) => lessonId.startsWith('__diagnostic_probe__'))

  for (const lessonId of staleProbeIds) {
    await ctx.supabaseAdmin
      .from(homeworkTable)
      .delete()
      .eq('student_id', studentId)
      .eq('lesson_id', lessonId)
  }

  const rows = rawRows.filter((row: any) => !String(row?.lesson_id || '').startsWith('__diagnostic_probe__'))
  const suspiciousHomework = homeworkError ? [] : rows.filter(homeworkStateSuspicious).map((row: any) => row.lesson_id)
  const legacyHomework = homeworkError ? [] : rows.filter((row: any) => Boolean(row.migrated_from_legacy)).map((row: any) => row.lesson_id)
  const pendingHomework = homeworkError ? [] : rows
    .filter((row: any) => row.status === 'submitted_pending_report')
    .map((row: any) => ({ lessonId: row.lesson_id, reportStatus: row.report_status, submittedAt: row.submitted_at || null }))

  let bot = { ok: false, error: botToken ? 'Not checked' : 'Telegram bot token is not configured for this student' } as any
  let chat = { ok: false, error: recipient.ok ? 'Not checked' : recipient.error || 'Recipient is not configured' } as any
  if (botToken) {
    const botResult = await telegramApi(botToken, 'getMe')
    bot = botResult.ok
      ? { ok: true, username: botResult.result?.username || null }
      : { ok: false, error: botResult.error }
    if (recipient.ok && Number.isSafeInteger(recipient.chatId)) {
      const chatResult = await telegramApi(botToken, 'getChat', { chat_id: recipient.chatId })
      chat = chatResult.ok
        ? { ok: true, type: chatResult.result?.type || null }
        : { ok: false, error: chatResult.error }
    }
  }

  return diagnosticJson({
    ok: !homeworkError && recipient.ok && bot.ok && chat.ok,
    diagnosticVersion: DIAGNOSTIC_VERSION,
    database: {
      ok: !homeworkError,
      error: homeworkError?.message || null,
      homeworkRows: rows.length,
      staleDiagnosticProbesRemoved: staleProbeIds.length,
      suspiciousHomework,
      pendingHomework,
      legacyHomework,
    },
    recipient: {
      ok: recipient.ok,
      enabled: recipient.enabled,
      source: recipient.source,
      threadId: recipient.threadId,
      error: recipient.error || null,
    },
    telegram: { bot, chat },
  })
}

export default {
  fetch: withSupabase({ auth: 'none' }, async (req, ctx) => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders })
    }
    if (req.method !== 'POST') {
      return Response.json({ ok: false, error: 'Method not allowed' }, { status: 405 })
    }

    let payload: any
    try {
      payload = await req.json()
    } catch {
      return diagnosticJson({ ok: false, error: 'Invalid JSON' }, 400)
    }

    const kind = typeof payload?.kind === 'string' ? payload.kind.trim() : ''
    if (kind.startsWith('diagnostics_')) {
      return handleDiagnostics(req, ctx, payload)
    }
    if (kind === 'homework_submit_report') {
      return handleHomeworkReport(req, ctx, payload)
    }

    const studentId = normalizeStudentId(payload?.studentId)
    if (!studentId) {
      return Response.json({ ok: false, error: 'Missing or invalid student_id' }, { status: 400 })
    }

    const expectedSecret = notifyWebhookSecretForStudent(studentId)
    const actualSecret = req.headers.get('x-notify-secret') ?? ''
    if (!expectedSecret || !secureEqual(actualSecret, expectedSecret)) {
      return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    const botToken = telegramBotTokenForStudent(studentId)
    if (!botToken) {
      return Response.json({ ok: false, error: 'Telegram bot token is not configured for this student' }, { status: 500 })
    }

    const materialType = typeof payload.materialType === 'string' ? payload.materialType.trim() : ''
    const materialId = typeof payload.materialId === 'string' ? payload.materialId.trim() : ''
    const notificationVersion = Number(payload.notificationVersion)
    const homework = payload.homework
    const vocabulary = payload.vocabulary
    const grammar = Array.isArray(payload.grammar) ? payload.grammar : []

    if (!materialType || !materialId || !Number.isInteger(notificationVersion) || notificationVersion < 1) {
      return Response.json({ ok: false, error: 'Missing or invalid notification identity' }, { status: 400 })
    }

    if (!homework || !isHttpUrl(homework.url)) {
      return Response.json({ ok: false, error: 'A valid homework URL is required' }, { status: 400 })
    }

    if (vocabulary && !isHttpUrl(vocabulary.url)) {
      return Response.json({ ok: false, error: 'Invalid vocabulary URL' }, { status: 400 })
    }

    for (const item of grammar) {
      if (!item || !isHttpUrl(item.url)) {
        return Response.json({ ok: false, error: 'Invalid grammar URL' }, { status: 400 })
      }
    }

    const { data: recipient, error: recipientError } = await ctx.supabaseAdmin
      .from('telegram_recipients')
      .select('chat_id, message_thread_id, enabled')
      .eq('student_id', studentId)
      .maybeSingle()

    if (recipientError) {
      return Response.json({ ok: false, error: recipientError.message }, { status: 500 })
    }

    if (recipient && !recipient.enabled) {
      return Response.json(
        { ok: false, error: 'Telegram recipient is explicitly disabled' },
        { status: 409 },
      )
    }

    const githubChatId = parseTelegramId(Deno.env.get('TEACHER_CHAT_ID'))
    const recipientChatId = recipient
      ? Number(recipient.chat_id)
      : githubChatId

    const recipientThreadId = recipient
      ? parseTelegramId(recipient.message_thread_id)
      : null

    if (!Number.isSafeInteger(recipientChatId)) {
      return Response.json(
        {
          ok: false,
          error: 'Telegram recipient is missing: add TEACHER_CHAT_ID to GitHub Actions Secrets and rerun setup workflow',
        },
        { status: 500 },
      )
    }

    const recipientSource = recipient ? 'database' : 'github_actions_secret'

    // A homework publication is a one-time event. Once any notification for
    // this material has been sent, edits to the lesson or changes to
    // notificationVersion must never produce another Telegram message.
    const { data: alreadySent, error: alreadySentError } = await ctx.supabaseAdmin
      .from('material_publications')
      .select('id, telegram_message_id, notification_version')
      .eq('student_id', studentId)
      .eq('material_type', materialType)
      .eq('material_id', materialId)
      .eq('status', 'sent')
      .order('sent_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (alreadySentError) {
      return Response.json({ ok: false, error: alreadySentError.message }, { status: 500 })
    }

    if (alreadySent) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: 'already_sent_once',
        telegramMessageId: alreadySent.telegram_message_id,
        originalNotificationVersion: alreadySent.notification_version,
      })
    }

    const { data: existing, error: existingError } = await ctx.supabaseAdmin
      .from('material_publications')
      .select('id, status, telegram_message_id')
      .eq('student_id', studentId)
      .eq('material_type', materialType)
      .eq('material_id', materialId)
      .eq('notification_version', notificationVersion)
      .maybeSingle()

    if (existingError) {
      return Response.json({ ok: false, error: existingError.message }, { status: 500 })
    }

    if (existing?.status === 'sent') {
      return Response.json({
        ok: true,
        skipped: true,
        reason: 'already_sent',
        telegramMessageId: existing.telegram_message_id,
      })
    }

    let publicationId = existing?.id as string | undefined

    if (publicationId) {
      const { error } = await ctx.supabaseAdmin
        .from('material_publications')
        .update({ status: 'pending', payload, error_message: null })
        .eq('id', publicationId)

      if (error) return Response.json({ ok: false, error: error.message }, { status: 500 })
    } else {
      const { data: created, error } = await ctx.supabaseAdmin
        .from('material_publications')
        .insert({
          student_id: studentId,
          material_type: materialType,
          material_id: materialId,
          notification_version: notificationVersion,
          status: 'pending',
          payload,
        })
        .select('id')
        .single()

      if (error) {
        if (error.code === '23505') {
          return Response.json({ ok: true, skipped: true, reason: 'already_claimed' })
        }
        return Response.json({ ok: false, error: error.message }, { status: 500 })
      }
      publicationId = created.id
    }

    const keyboard: Array<Array<{ text: string; url: string }>> = []
    if (vocabulary) keyboard.push([{ text: '📚 Learn new words', url: vocabulary.url }])
    if (grammar.length === 1) {
      keyboard.push([{ text: '📘 Grammar', url: grammar[0].url }])
    } else if (grammar.length > 1) {
      for (const item of grammar) {
        keyboard.push([{ text: `📘 ${item.title}`, url: item.url }])
      }
    }
    keyboard.push([{ text: '📝 Do the homework', url: homework.url }])

    try {
      const telegramMessage = await sendTelegramMessage(
        botToken,
        recipientChatId,
        recipientThreadId,
        buildMessage(
          Boolean(vocabulary),
          grammar.length > 0,
          homework.title,
          `${materialId}:${notificationVersion}`,
        ),
        keyboard,
      )

      const { error: updateError } = await ctx.supabaseAdmin
        .from('material_publications')
        .update({
          status: 'sent',
          telegram_message_id: telegramMessage.message_id,
          sent_at: new Date().toISOString(),
          error_message: null,
        })
        .eq('id', publicationId)

      if (updateError) {
        throw new Error(`Telegram sent, but log update failed: ${updateError.message}`)
      }

      return Response.json({
        ok: true,
        skipped: false,
        recipientSource,
        telegramMessageId: telegramMessage.message_id,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await ctx.supabaseAdmin
        .from('material_publications')
        .update({ status: 'failed', error_message: message })
        .eq('id', publicationId)

      return Response.json({ ok: false, error: message }, { status: 502 })
    }
  }),
}
