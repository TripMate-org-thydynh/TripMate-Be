import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = new URL(process.env.TEST_API_BASE || 'http://127.0.0.1:3000/api/v1');
if (!['localhost', '127.0.0.1'].includes(base.hostname)) {
  throw new Error('Run this test against a local test API.');
}

async function call(method, path, token, data) {
  const response = await fetch(base.href.replace(/\/$/, '') + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'Content-Type': 'application/json' } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  return { status: response.status, data: body.data, message: body.message };
}

function ok(result) {
  assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result));
  return result.data;
}

async function account() {
  const username = 'test_bill_' + randomUUID().slice(0, 8);
  const password = 'TripMate-test-' + randomUUID();
  const data = ok(await call('POST', '/auth/register-password', null, {
    username, password, confirmPassword: password,
  }));
  const token = data.accessToken || data.token;
  assert.ok(token);
  return {
    token,
    id: JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub,
  };
}

const [host, friend, outsider] = await Promise.all([account(), account(), account()]);
const trip = ok(await call('POST', '/trips', host.token, {
  name: 'Receipt beta fixture', destination: 'Đà Lạt', currency: 'VND',
  startDate: new Date(Date.now() + 86_400_000).toISOString(),
  endDate: new Date(Date.now() + 172_800_000).toISOString(),
}));
ok(await call('POST', '/trips/join', friend.token, { inviteCode: trip.inviteCode }));
const basePath = `/trips/${trip.id}/receipt-drafts`;
const input = {
  id: randomUUID(), title: 'Bill thử', total: 105_000, fee: 8_000, discount: 3_000,
  lines: [
    { name: 'Cà phê', amount: 32_000 },
    { name: 'Trà đào', amount: 42_000 },
    { name: 'Bánh dùng chung', amount: 26_000 },
  ],
};
const pair = await Promise.all([host, host].map(actor => call('POST', basePath, actor.token, input)));
const draft = ok(pair[0]);
assert.equal(ok(pair[1]).lines.length, 3);
const path = `${basePath}/${draft.id}`;
assert.equal((await call('GET', path, outsider.token)).status, 404);
assert.equal((await call('POST', path + '/finalize', host.token, { version: 0 })).status, 400);

const claim = (actor, line, assigneeIds, version = 0) =>
  call('PUT', `${path}/lines/${line.id}/assignment`, actor.token, { version, assigneeIds });
const [coffee, tea, pastry] = draft.lines;
const race = await Promise.all([host, friend].map(actor => claim(actor, coffee, [host.id])));
assert.equal(race.filter(result => result.status === 200).length, 1);
assert.equal(race.filter(result => result.status === 409).length, 1);
assert.equal((await claim(friend, tea, [outsider.id])).status, 400);
ok(await claim(host, tea, [friend.id]));
const assigned = ok(await claim(friend, pastry, [host.id, friend.id]));
assert.equal(assigned.allocation.complete, true);
assert.equal(assigned.allocation.shares.reduce((sum, { amount }) => sum + amount, 0), input.total);
assert.equal((await call('POST', path + '/finalize', friend.token, { version: assigned.version })).status, 403);
const close = () => call('POST', path + '/finalize', host.token, { version: assigned.version });
const both = await Promise.all([close(), close()]);
assert.equal(ok(both[0]).expenseId, ok(both[1]).expenseId);
const expenses = ok(await call('GET', `/trips/${trip.id}/expenses`, friend.token));
assert.equal(expenses.filter(expense => expense.description === input.title).length, 1);

const pending = ok(await call('POST', basePath, host.token, {
  id: randomUUID(), title: 'Member leaves', total: 30_000, lines: [{ name: 'Tea', amount: 30_000 }],
}));
const pendingPath = `${basePath}/${pending.id}`;
const prepared = ok(await call('PUT', `${pendingPath}/lines/${pending.lines[0].id}/assignment`, friend.token, {
  version: 0, assigneeIds: [friend.id],
}));
ok(await call('DELETE', `/trips/${trip.id}/leave`, friend.token));
assert.equal((await call('GET', pendingPath, friend.token)).status, 404);
assert.equal((await call('POST', pendingPath + '/finalize', host.token, { version: prepared.version })).status, 409);
assert.equal(ok(await call('GET', `/trips/${trip.id}/expenses`, host.token)).length, expenses.length);
console.log('Receipt E2E passed: membership, replay, concurrent claims/finalization, proportional allocation and member departure.');
