
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const users = await prisma.user.findMany({ select: { id: true, email: true, name: true } });
  console.log('USERS:', JSON.stringify(users, null, 2));
  const trips = await prisma.trip.findMany({ select: { id: true, name: true, inviteCode: true, members: { select: { userId: true, role: true } } } });
  console.log('TRIPS:', JSON.stringify(trips, null, 2));
}
main().catch(console.error).finally(() => prisma.());
