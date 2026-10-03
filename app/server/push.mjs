import webpush from 'web-push';

export class PushService {
  constructor(config, store) {
    this.store = store;
    this.enabled = Boolean(config.vapidPublicKey && config.vapidPrivateKey);
    this.publicKey = config.vapidPublicKey;
    if (this.enabled) webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  }

  async notifyItem(item) {
    if (!this.enabled) return;
    const payload = JSON.stringify(notificationPayload(item));
    await Promise.allSettled(this.store.subscriptions().map(async ({ endpoint, subscription }) => {
      try {
        await webpush.sendNotification(subscription, payload, { TTL: 3600, urgency: 'normal' });
      } catch (error) {
        if (error?.statusCode === 404 || error?.statusCode === 410) this.store.removeSubscription(endpoint);
        else console.error(`Push delivery failed: ${error?.message || error}`);
      }
    }));
  }

  async notifyDigest(summary) {
    if (!this.enabled || !summary?.open) return;
    const payload = JSON.stringify({
      title: `${summary.open} Threadmark ${summary.open === 1 ? 'item' : 'items'} waiting`,
      body: `${summary.payments} payments · ${summary.meetings} meetings · ${summary.reminders} reminders`,
      url: '/', tag: `threadmark-digest-${new Date().toISOString().slice(0, 10)}`, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    });
    await Promise.allSettled(this.store.subscriptions().map(async ({ endpoint, subscription }) => {
      try { await webpush.sendNotification(subscription, payload, { TTL: 21_600, urgency: 'low' }); }
      catch (error) {
        if (error?.statusCode === 404 || error?.statusCode === 410) this.store.removeSubscription(endpoint);
      }
    }));
  }
}

export function notificationPayload(item) {
  const urgent = Number(item.priority) >= 0.78;
  const warning = Array.isArray(item.details?.safetyAlerts) && item.details.safetyAlerts.length;
  const baseTitle = item.details?.needsReview ? 'Photo needs review' : warning ? 'Payment warning' : item.details?.invoice ? 'Invoice received' : item.details?.subscription ? 'Subscription update' : item.type === 'payment' ? 'Payment mentioned' : item.type === 'meeting' ? 'Meeting mentioned' : 'Reminder matched';
  return {
    title: urgent ? `Urgent · ${baseTitle}` : baseTitle,
    body: `${item.source?.name || item.group.name}: ${item.title}`,
    url: `/#item=${encodeURIComponent(item.id)}`,
    actionsUrl: `/#item=${encodeURIComponent(item.id)}&actions=1`,
    itemId: item.id,
    actions: [{ action: 'done', title: 'Done' }, { action: 'actions', title: 'Actions' }],
    tag: item.id,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  };
}
