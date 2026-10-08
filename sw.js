/* DOS Akademie — Service Worker للإشعارات (مكالمات + رسائل)
   ضع هذا الملف بجانب index.html (نفس المجلد) على نفس النطاق (https). */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (error) { data = { title: "DOS Akademie", body: event.data ? event.data.text() : "" }; }
  const isCall = data.type === "call";

  event.waitUntil((async () => {
    // لو الموقع مفتوح ومرئي، الموقع نفسه يعرض الرنين/الإشعار — لا نكرره
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (windows.some((client) => client.visibilityState === "visible" && client.focused !== false)) return;

    await self.registration.showNotification(data.title || "DOS Akademie", {
      body: data.body || "",
      tag: isCall ? `dos-call-${data.callId || "x"}` : (data.tag || "dos-chat"),
      renotify: true,
      requireInteraction: isCall,
      vibrate: isCall ? [500, 250, 500, 250, 500, 250, 500] : [120],
      data: { type: data.type || "chat", callId: data.callId || null },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil((async () => {
    const scope = self.registration.scope;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const target = windows.find((client) => client.url.startsWith(scope));
    if (target) {
      await target.focus();
      target.postMessage({ type: "dos-notification-click", data });
      return;
    }
    const url = new URL(scope);
    if (data.callId) url.searchParams.set("dosCall", data.callId);
    url.searchParams.set("dosOpen", data.type || "chat");
    await self.clients.openWindow(url.toString());
  })());
});
