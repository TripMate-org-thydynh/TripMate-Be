const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { PrismaClient } = require('@prisma/client');

const migrations = [
  '20261126120000_app_policy_storage',
  '20261126121000_observability_storage',
  '20261128120000_receipt_drafts',
  '20261128121000_announcement_campaigns',
  '20261128122000_template_review',
];

async function prepareOperationsSchema(prisma) {
  const sources = await Promise.all(migrations.map((migration) =>
    readFile(join(__dirname, '..', 'prisma', 'migrations', migration, 'migration.sql'), 'utf8'),
  ));
  await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT pg_advisory_xact_lock(162457, 20261126) IS NULL AS locked`;
    for (const source of sources) {
      // These bundled release migrations contain only semicolon-delimited DDL.
      for (const statement of source.split(';').map((part) => part.trim()).filter(Boolean)) {
        await transaction.$executeRawUnsafe(statement);
      }
    }
  }, { maxWait: 15_000, timeout: 60_000 });
}

async function main() {
  const prisma = new PrismaClient();
  try {
    await prepareOperationsSchema(prisma);
    console.log('TripMate operations schema is ready.');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    const code = typeof error?.code === 'string' && /^P\d{4}$/.test(error.code) ? ` (${error.code})` : '';
    console.error(`Could not prepare the TripMate operations schema${code}.`);
    process.exitCode = 1;
  });
}

module.exports = { prepareOperationsSchema };
