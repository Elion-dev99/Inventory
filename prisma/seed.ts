import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ROLES: Array<{ code: string; name: string }> = [
  { code: 'SYSTEM_ADMIN', name: 'システム管理者' },
  { code: 'INVENTORY_MANAGER', name: '在庫管理者' },
  { code: 'INVENTORY_STAFF', name: '在庫担当者' },
  { code: 'VIEWER', name: '閲覧者' },
  { code: 'AUDITOR', name: '監査者' },
];

async function main(): Promise<void> {
  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { code: role.code },
      update: { name: role.name },
      create: role,
    });
  }
  console.log(`Seeded ${ROLES.length} roles`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
