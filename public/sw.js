// Notification-only worker: no page control, fetch interception or offline cache.

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data;
  if (!target || typeof target.botId !== "string" || !target.botId ||
      typeof target.threadId !== "string" || !target.threadId) return;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (new URL(client.url).origin === self.location.origin && new URL(client.url).pathname === "/" && "focus" in client) {
            client.postMessage({ type: "openmausbot:notification-click", target });
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(`/#notification=${encodeURIComponent(JSON.stringify(target))}`);
        }
      }),
  );
});
