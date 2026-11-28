import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const base = new URL(process.env.TEST_API_BASE || 'http://127.0.0.1:3000/api/v1');
const database = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(base.hostname));
assert.ok(['localhost', '127.0.0.1'].includes(database.hostname));
const prisma = new PrismaClient();

async function call(method, path, token, data) {
  const res = await fetch(base.href.replace(/\/$/, '') + path, {
    method,
    signal: AbortSignal.timeout(5000),
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  });
  return { path, status: res.status, json: await res.json() };
}

function ok(res) {
  assert.ok(res.status >= 200 && res.status < 300, `HTTP ${res.status} at ${res.path}`);
  return res.json.data;
}

async function account() {
  const username = 'ops_' + randomUUID().slice(0, 8);
  const password = 'Beta-fixture-' + randomUUID();
  const data = ok(await call('POST', '/auth/register-password', null, { username, password, confirmPassword: password }));
  const token = data.accessToken || data.token;
  assert.ok(token);
  const id = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  return { token, id };
}

try {
  const admin = await account();
  const guest = await account();
  await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
  assert.equal((await call('GET', '/admin/capabilities', guest.token)).status, 403);
  const url = '/admin/capabilities/receiptOcr';
  const previous = ok(await call('GET', '/admin/capabilities', admin.token)).policies.receiptOcr;
  ok(await call('PUT', url, admin.token, { mode: 'maintenance', reason: 'Local E2E', expectedVersion: previous.version }));
  try {
    assert.equal(ok(await call('GET', '/app-config')).capabilities.receiptOcr.mode, 'maintenance');
    const blocked = await call('POST', '/trips/' + randomUUID() + '/expenses/ocr', guest.token, { receiptUrl: '' });
    assert.equal(blocked.status, 503);
    assert.equal((await call('PUT', url, admin.token, {
      mode: 'hidden', reason: 'Stale version', expectedVersion: previous.version,
    })).status, 409);
  } finally {
    ok(await call('PUT', url, admin.token, {
      mode: previous.mode, message: previous.message, expiresAt: previous.expiresAt ?? undefined,
      reason: 'Restore after local E2E', expectedVersion: previous.version + 1,
    }));
  }

  const editorial = ok(await call('GET', '/public/trip-templates'));
  assert.equal(editorial.length, 12);
  assert.equal(new Set(editorial.map(row => row.destination)).size, 6);
  assert.equal(editorial.find(row => row.dayCount === 3 && row.items.length === 12).items.length, 12);
  const trip = ok(await call('POST', '/trips', guest.token, {
    name: 'Template review E2E', startDate: new Date(Date.now() + 3600000).toISOString(),
    endDate: new Date(Date.now() + 90000000).toISOString(), destination: 'Da Lat',
  }));
  const photo = { tripId: trip.id, userId: guest.id, mediaUrl: 'https://example.invalid/photo.jpg' };
  const createdAt = new Date();
  await prisma.moment.createMany({ data: [
    ...Array.from({ length: 25 }, () => ({ ...photo, createdAt })),
    { ...photo, isGhost: true },
    { ...photo, deletedAt: createdAt },
    { ...photo, mediaUrl: '' },
    { ...photo, type: 'VIDEO' },
  ] });
  const gallery = '/trips/' + trip.id + '/moments/gallery';
  assert.equal((await call('GET', gallery, admin.token)).status, 404);
  const firstPage = ok(await call('GET', gallery, guest.token));
  assert.equal(firstPage.items.length, 24);
  assert.ok(firstPage.nextCursor);
  const secondPage = ok(await call('GET', gallery + '?cursor=' + firstPage.nextCursor, guest.token));
  assert.equal(secondPage.items.length, 1);
  assert.ok(firstPage.items.every(item => item.id !== secondPage.items[0].id));
  assert.equal(secondPage.nextCursor, null);

  await call('POST', '/trips/' + trip.id + '/itinerary', guest.token, {
    day: 1, placeName: 'Public fixture stop', placeAddress: 'Private fixture address',
    startTime: '07:00', durationMinutes: 60, notes: 'Private fixture note',
  }).then(ok);
  const template = ok(await call('POST', '/trips/' + trip.id + '/itinerary/templates', guest.token, {
    title: 'Template review E2E', isPublic: true, includeNotes: true,
  }));
  assert.equal(template.reviewStatus, 'PENDING');
  const detail = () => call('GET', '/itinerary-templates/' + template.id, admin.token);
  assert.equal((await detail()).status, 404);
  await call('POST', '/admin/template-review/' + template.id, admin.token, { approve: true, reason: 'Local E2E' }).then(ok);
  const published = ok(await detail());
  assert.equal(published.items[0].notes, null);
  assert.equal(published.items[0].placeAddress, null);
  assert.equal(published.sourceTripId, null);
  await call('POST', '/admin/template-review/' + template.id, admin.token, { approve: false, reason: 'Local cleanup' }).then(ok);
  assert.equal((await detail()).status, 404);

  const campaign = ok(await call('POST', '/admin/campaigns', admin.token, {
    title: 'Local beta event', body: 'Local fixture.', cta: 'templates', platform: 'all', popup: true, push: false,
    startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: new Date(Date.now() + 120000).toISOString(),
  }));
  const schedule = '/admin/campaigns/' + campaign.id + '/schedule';
  assert.equal(ok(await call('POST', schedule, admin.token, { userIds: [guest.id], reason: 'Local E2E' })).recipientCount, 1);
  assert.equal((await call('POST', schedule, admin.token, { userIds: [guest.id], reason: 'Retry' })).status, 409);
  let inbox = [];
  for (let attempt = 0; attempt < 13; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    inbox = ok(await call('GET', '/notifications', guest.token)).filter(item => item.data?.campaignId === campaign.id);
    if (inbox.length) break;
  }
  assert.equal(inbox.length, 1);
  const claim = '/notifications/events/claim';
  const claims = await Promise.all([call('POST', claim, guest.token, {}), call('POST', claim, guest.token, {})]);
  assert.equal(claims.map(ok).filter(item => item?.id === campaign.id).length, 1);
  const delivered = ok(await call('GET', '/admin/campaigns', admin.token)).find(item => item.id === campaign.id);
  assert.equal(delivered.inAppCount, 1);
  assert.equal(delivered.pushAccepted, 0);
  await call('POST', '/admin/campaigns/' + campaign.id + '/stop', admin.token, { reason: 'Local cleanup' }).then(ok);
  console.log('Operations E2E passed: feature policy, paginated trip gallery, template privacy, inbox and popup deduplication.');
} finally {
  await prisma.$disconnect();
}
