import { createClient } from 'npm:@supabase/supabase-js@2'

const DIAGNOSTIC_VERSION = 'zakiya-diagnostics-v1'
const STUDENT_ID = 'zakiya'
const DIAGNOSTIC_COOLDOWN_MS = 30_000
const encoder = new TextEncoder()

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json({ ...body, diagnosticVersion: DIAGNOSTIC_VERSION }, { status, headers: corsHeaders })
}

function safeText(value: unknown, fallback = ''): string {
  return value === undefined || value === null ? fallback : String(value)
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? 'Unknown error'))
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[hidden]')
    .replace(/eyJ[A-Za-z0-9._-]+/g, '[hidden key]')
    .slice(0, 500)
}

function escapeHtml(value: unknown): string {
  return safeText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function secureEqual(left: string, right: string): boolean {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
  return diff === 0
}

function requestApiKey(request: Request): string {
  const direct = (request.headers.get('apikey') || '').trim()
  if (direct) return direct
  const auth = (request.headers.get('authorization') || '').trim()
  const match = auth.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

async function publicClientAuthorized(request: Request): Promise<boolean> {
  const apiKey = requestApiKey(request)
  if (!apiKey) return false
  const explicit = [
    Deno.env.get('SUPABASE_ANON_KEY') || '',
    Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || '',
  ].map((v) => v.trim()).filter(Boolean)
  if (explicit.some((key) => secureEqual(apiKey, key))) return true

  const supabaseUrl = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '')
  if (!supabaseUrl) return false
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/settings`, {
      method: 'GET',
      headers: { apikey: apiKey },
      signal: AbortSignal.timeout(5000),
    })
    await response.body?.cancel().catch(() => undefined)
    return response.ok
  } catch {
    return false
  }
}

async function telegramApi(token: string, method: string, body?: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.ok) return { ok: false, error: result?.description || `Telegram HTTP ${response.status}` }
  return { ok: true, result: result.result }
}

function homeworkStateSuspicious(row: Record<string, any>): boolean {
  const status = String(row?.status || '')
  const report = String(row?.report_status || '')
  if (status === 'draft') return report !== 'not_sent'
  if (status === 'submitted_pending_report') return !['pending', 'failed'].includes(report)
  if (status === 'submitted') return !['sent', 'not_sent'].includes(report)
  return true
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)

  if (!await publicClientAuthorized(request)) return json({ ok: false, error: 'Unauthorized diagnostics request' }, 401)

  try {
    const payload = await request.json().catch(() => ({}))
    const studentId = safeText(payload.studentId).trim().toLowerCase()
    if (studentId !== STUDENT_ID) return json({ ok: false, error: 'Invalid diagnostics student_id' }, 403)

    const supabaseUrl = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '')
    const serviceRoleKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim()
    const botToken = (Deno.env.get('TELEGRAM_BOT_TOKEN') || '').trim()
    if (!supabaseUrl || !serviceRoleKey) return json({ ok: false, error: 'Supabase server configuration is incomplete' }, 500)
    if (!botToken) return json({ ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' }, 500)

    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const kind = safeText(payload.kind)
    const homeworkTable = 'homework_progress'

    if (kind === 'diagnostics_cleanup_probe') {
      const lessonId = safeText(payload.lessonId)
      if (!lessonId.startsWith('__diagnostic_probe__')) return json({ ok: false, error: 'Invalid diagnostics lesson id' }, 400)
      const { error } = await admin.from(homeworkTable).delete().eq('student_id', STUDENT_ID).eq('lesson_id', lessonId)
      return error ? json({ ok: false, error: safeError(error) }, 500) : json({ ok: true })
    }

    if (kind === 'diagnostics_homework_probe') {
      const lessonId = safeText(payload.lessonId)
      if (!lessonId.startsWith('__diagnostic_probe__')) return json({ ok: false, error: 'Invalid diagnostics lesson id' }, 400)
      const stages: Record<string, string> = {}
      try {
        const { data: draft, error: readError } = await admin.from(homeworkTable)
          .select('student_id,lesson_id,status,report_status')
          .eq('student_id', STUDENT_ID).eq('lesson_id', lessonId).maybeSingle()
        if (readError) throw new Error(`service_read_draft: ${readError.message}`)
        if (!draft) throw new Error('service_read_draft: browser draft was not found')
        if (draft.status !== 'draft' || draft.report_status !== 'not_sent') throw new Error(`service_read_draft: unexpected state ${draft.status}/${draft.report_status}`)
        stages.browserDraft = 'ok'

        const submittedAt = new Date().toISOString()
        const { error: pendingError } = await admin.from(homeworkTable).update({
          status: 'submitted_pending_report', submitted_at: submittedAt, locked_at: submittedAt,
          report_status: 'pending', report_sent_at: null, report_error: null,
        }).eq('student_id', STUDENT_ID).eq('lesson_id', lessonId)
        if (pendingError) throw new Error(`pending_transition: ${pendingError.message}`)
        stages.pendingTransition = 'ok'

        const sentAt = new Date().toISOString()
        const { error: submittedError } = await admin.from(homeworkTable).update({
          status: 'submitted', report_status: 'sent', report_sent_at: sentAt, report_error: null,
        }).eq('student_id', STUDENT_ID).eq('lesson_id', lessonId)
        if (submittedError) throw new Error(`submitted_transition: ${submittedError.message}`)
        stages.submittedTransition = 'ok'

        const { error: cleanupError } = await admin.from(homeworkTable).delete().eq('student_id', STUDENT_ID).eq('lesson_id', lessonId)
        if (cleanupError) throw new Error(`cleanup: ${cleanupError.message}`)
        stages.cleanup = 'ok'
        return json({ ok: true, stages })
      } catch (error) {
        await admin.from(homeworkTable).delete().eq('student_id', STUDENT_ID).eq('lesson_id', lessonId)
        return json({ ok: false, error: safeError(error), stages }, 500)
      }
    }

    const { data: recipient, error: recipientError } = await admin.from('telegram_recipients')
      .select('chat_id,message_thread_id,enabled')
      .eq('student_id', STUDENT_ID).maybeSingle()
    const recipientOk = !recipientError && Boolean(recipient?.enabled)

    if (kind === 'diagnostics_send_report') {
      if (!recipientOk) return json({ ok: false, error: recipientError ? safeError(recipientError) : 'Telegram recipient is not configured or disabled' }, 500)

      const cutoff = new Date(Date.now() - DIAGNOSTIC_COOLDOWN_MS).toISOString()
      const { data: recent } = await admin.from('material_publications')
        .select('created_at').eq('student_id', STUDENT_ID)
        .eq('material_type', 'diagnostic').eq('material_id', 'zakiya-telegram-test')
        .gte('created_at', cutoff).order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (recent?.created_at) {
        const elapsed = Date.now() - Date.parse(recent.created_at)
        return json({ ok: true, skipped: true, retryAfterSeconds: Math.max(1, Math.ceil((DIAGNOSTIC_COOLDOWN_MS - elapsed) / 1000)), threadId: recipient?.message_thread_id ?? null })
      }

      const version = Math.max(1, Math.floor(Date.now() / 1000))
      const { data: publication, error: publicationError } = await admin.from('material_publications').insert({
        student_id: STUDENT_ID,
        material_type: 'diagnostic',
        material_id: 'zakiya-telegram-test',
        notification_version: version,
        status: 'pending',
        payload: { kind, pageUrl: typeof payload.pageUrl === 'string' ? payload.pageUrl : null },
      }).select('id').single()
      if (publicationError) return json({ ok: false, error: safeError(publicationError) }, 500)

      const telegramPayload: Record<string, unknown> = {
        chat_id: recipient!.chat_id,
        text: ['🧪 <b>English Space diagnostics test</b>', '', '<code>student_id=zakiya</code>: site → Supabase → Edge Function → Telegram works.', '', 'This is a service test message. Homework and progress were not changed.'].join('\n'),
        parse_mode: 'HTML',
      }
      if (recipient!.message_thread_id) telegramPayload.message_thread_id = recipient!.message_thread_id

      const sent = await telegramApi(botToken, 'sendMessage', telegramPayload)
      if (!sent.ok) {
        await admin.from('material_publications').update({ status: 'failed', error_message: sent.error }).eq('id', publication.id)
        return json({ ok: false, error: sent.error }, 502)
      }
      await admin.from('material_publications').update({
        status: 'sent', telegram_message_id: sent.result?.message_id, sent_at: new Date().toISOString(), error_message: null,
      }).eq('id', publication.id)
      return json({ ok: true, skipped: false, telegramMessageId: sent.result?.message_id, threadId: recipient!.message_thread_id ?? null })
    }

    if (kind !== 'diagnostics_health') return json({ ok: false, error: 'Unknown diagnostics request' }, 400)

    const { data: rowsRaw, error: homeworkError } = await admin.from(homeworkTable)
      .select('lesson_id,status,report_status,migrated_from_legacy,submitted_at')
      .eq('student_id', STUDENT_ID)
    const rowsBeforeCleanup = rowsRaw || []
    const staleProbes = rowsBeforeCleanup.map((r: any) => safeText(r.lesson_id)).filter((id: string) => id.startsWith('__diagnostic_probe__'))
    for (const lessonId of staleProbes) await admin.from(homeworkTable).delete().eq('student_id', STUDENT_ID).eq('lesson_id', lessonId)
    const rows = rowsBeforeCleanup.filter((r: any) => !safeText(r.lesson_id).startsWith('__diagnostic_probe__'))
    const suspiciousHomework = homeworkError ? [] : rows.filter((r: any) => homeworkStateSuspicious(r)).map((r: any) => r.lesson_id)

    const botResult = await telegramApi(botToken, 'getMe')
    const chatResult = recipientOk ? await telegramApi(botToken, 'getChat', { chat_id: recipient!.chat_id }) : { ok: false, error: recipientError ? safeError(recipientError) : 'Recipient is not configured' }

    return json({
      ok: !homeworkError && recipientOk && botResult.ok && chatResult.ok,
      database: {
        ok: !homeworkError,
        error: homeworkError ? safeError(homeworkError) : null,
        homeworkRows: rows.length,
        staleDiagnosticProbesRemoved: staleProbes.length,
        suspiciousHomework,
      },
      recipient: {
        ok: recipientOk,
        enabled: Boolean(recipient?.enabled),
        threadId: recipient?.message_thread_id ?? null,
        error: recipientError ? safeError(recipientError) : (!recipientOk ? 'Recipient is disabled or missing' : null),
      },
      telegram: {
        bot: botResult.ok ? { ok: true, username: botResult.result?.username || null } : { ok: false, error: botResult.error },
        chat: chatResult.ok ? { ok: true, type: chatResult.result?.type || null } : { ok: false, error: chatResult.error },
      },
    })
  } catch (error) {
    return json({ ok: false, error: safeError(error) }, 500)
  }
})
