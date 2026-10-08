// Supabase Edge Function: send-push
// تُستدعى من Database Webhooks عند INSERT في الجدولين: call_signals و chat_messages
// وترسل Web Push لأجهزة المستلم حتى لو كان الموقع مغلقاً.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

// إعدادات قابلة للتعديل
const CHAT_PUSH_TO_ADMINS_ON_STUDENT_DIRECT = true; // رسالة طالب خاصة تصل للأدمن أيضاً
const CALL_TTL_SECONDS = 60;                          // المكالمة تنتهي صلاحيتها بعد دقيقة
const CHAT_TTL_SECONDS = 24 * 3600;

type Payload = Record<string, unknown>;

async function sendToProfiles(profileIds: string[], payload: Payload, ttl: number, urgency: "high" | "normal") {
  const ids = [...new Set(profileIds.filter(Boolean))];
  if (!ids.length) return;
  const { data: subs } = await supabase.from("push_subscriptions").select("id, endpoint, p256dh, auth").in("profile_id", ids);
  await Promise.all((subs ?? []).map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { TTL: ttl, urgency },
      );
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await supabase.from("push_subscriptions").delete().eq("id", sub.id);
      else console.error("push failed", status, (error as Error).message);
    }
  }));
}

async function handleCall(row: Record<string, any>) {
  if (row.kind !== "invite") return;
  const createdAt = new Date(row.created_at).getTime();
  if (Date.now() - createdAt > 90_000) return;
  const info = row.payload ?? {};
  const rejoin = !!info.rejoin;
  const video = !!info.video;
  await sendToProfiles([row.to_id], {
    type: "call",
    callId: row.call_id,
    title: rejoin ? "العودة للمكالمة" : video ? "مكالمة فيديو واردة" : "مكالمة واردة",
    body: info.name ?? "DOS Akademie",
  }, CALL_TTL_SECONDS, "high");
}

function chatPreview(row: Record<string, any>) {
  if (row.kind === "voice") return "🎙️ رسالة صوتية";
  if (row.kind === "image") return "🖼️ صورة";
  if (row.kind === "call") return row.body ?? "📞 مكالمة";
  const text = String(row.body ?? "");
  return text.length > 120 ? text.slice(0, 117) + "…" : text;
}

async function handleChat(row: Record<string, any>) {
  if (row.kind === "call") return; // سجلات المكالمات لا تحتاج إشعاراً
  const sender = row.sender_profile_id;
  const recipients: string[] = [];

  if (row.room_type === "direct") {
    const studentId = row.student_profile_id;
    if (sender === studentId) {
      const { data: student } = await supabase.from("students").select("instructor_id").eq("profile_id", studentId).maybeSingle();
      if (student?.instructor_id) recipients.push(student.instructor_id);
      if (CHAT_PUSH_TO_ADMINS_ON_STUDENT_DIRECT) {
        const { data: admins } = await supabase.from("profiles").select("id").eq("role", "admin");
        (admins ?? []).forEach((admin) => recipients.push(admin.id));
      }
    } else {
      recipients.push(studentId);
    }
  } else if (row.room_type === "group" && row.group_name) {
    const { data: members } = await supabase.from("students").select("profile_id, instructor_id").eq("group_name", row.group_name);
    (members ?? []).forEach((member) => { recipients.push(member.profile_id); if (member.instructor_id) recipients.push(member.instructor_id); });
  }

  const targets = recipients.filter((id) => id && id !== sender);
  await sendToProfiles(targets, {
    type: "chat",
    tag: row.room_type === "group" ? `dos-chat-g-${row.group_name}` : `dos-chat-d-${row.student_profile_id}`,
    title: row.room_type === "group" ? `${row.sender_name ?? "رسالة جديدة"} — ${row.group_name}` : (row.sender_name ?? "رسالة جديدة"),
    body: chatPreview(row),
  }, CHAT_TTL_SECONDS, "normal");
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("WEBHOOK_SECRET");
  if (secret && req.headers.get("x-webhook-secret") !== secret) return new Response("forbidden", { status: 403 });
  try {
    const body = await req.json();
    if (body.type !== "INSERT" || !body.record) return new Response("ignored");
    if (body.table === "call_signals") await handleCall(body.record);
    else if (body.table === "chat_messages") await handleChat(body.record);
    return new Response("ok");
  } catch (error) {
    console.error(error);
    return new Response("error", { status: 500 });
  }
});
