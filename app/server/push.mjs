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

  async dismissItems(payload) {
    if (!this.enabled || !payload.itemIds?.length) return;
    const batches = [];
    let ids = [];
    for (const id of payload.itemIds) {
      if (ids.length && Buffer.byteLength(JSON.stringify({ ...payload, itemIds: [...ids, id] })) > 3500) {
        batches.push(JSON.stringify({ ...payload, itemIds: ids }));
        ids = [];
      }
      ids.push(id);
    }
    if (ids.length) batches.push(JSON.stringify({ ...payload, itemIds: ids }));
    // Older workers would render this control message as a new generic alert.
    await Promise.allSettled(this.store.subscriptions().filter(({ subscription }) => subscription.threadmarkDismissal === true).map(async ({ endpoint, subscription }) => {
      try {
        for (const batch of batches) await webpush.sendNotification(subscription, batch, { TTL: 3600, urgency: 'normal' });
      } catch (error) {
        if (error?.statusCode === 404 || error?.statusCode === 410) this.store.removeSubscription(endpoint);
      }
    }));
  }

  async notifyDigest(summary, profile = { id: 'personal', name: 'Personal' }) {
    if (!this.enabled || !summary?.open) return;
    const payload = JSON.stringify({
      title: `${profile.name} · ${summary.open} Threadmark ${summary.open === 1 ? 'item' : 'items'} waiting`,
      body: `${summary.payments} payments · ${summary.meetings} meetings · ${summary.reminders} reminders`,
      url: `/?profile=${encodeURIComponent(profile.id)}`, tag: `threadmark-digest-${profile.id}-${new Date().toISOString().slice(0, 10)}`, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
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
  const profileId = item.profile?.id || 'personal';
  const profileName = item.profile?.name || 'Personal';
  const prefix = profileId === 'personal' ? '' : `${profileName} · `;
  const profilePath = profileId === 'personal' ? '/' : `/?profile=${encodeURIComponent(profileId)}`;
  return {
    issuedAt: new Date().toISOString(),
    title: `${prefix}${urgent ? `Urgent · ${baseTitle}` : baseTitle}`,
    body: `${item.source?.name || item.group.name}: ${item.title}`,
    url: `${profilePath}#item=${encodeURIComponent(item.id)}`,
    actionsUrl: `${profilePath}#item=${encodeURIComponent(item.id)}&actions=1`,
    itemId: item.id,
    // The service worker folds alerts still on screen into one summary per profile.
    category: item.type,
    urgent,
    profileId,
    profileName,
    profileUrl: profilePath,
    actions: [{ action: 'done', title: 'Done' }, { action: 'actions', title: 'Actions' }],
    tag: `${profileId}:${item.id}`,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  };
}
