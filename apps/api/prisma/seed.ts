import { PrismaClient, Role } from "@prisma/client";
import { mvpCleaningServices } from "@ai-cleaning/shared";
import { randomBytes, scryptSync } from "node:crypto";

const prisma = new PrismaClient();

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

async function main() {
  const seedDemoUsers = process.env.SEED_DEMO_USERS === "true";
  if (seedDemoUsers && process.env.NODE_ENV === "production") {
    throw new Error("Demo users cannot be seeded in production");
  }

  for (const service of mvpCleaningServices) {
    await prisma.serviceCatalog.upsert({
      where: { id: service.id },
      update: {
        title: service.title,
        basePrice: service.basePrice,
        durationMinutes: service.durationMinutes,
        mvp: service.mvp
      },
      create: {
        id: service.id,
        title: service.title,
        basePrice: service.basePrice,
        durationMinutes: service.durationMinutes,
        mvp: service.mvp
      }
    });
  }

  if (!seedDemoUsers) return;
  const demoPassword = process.env.SEED_DEMO_PASSWORD;
  if (!demoPassword || demoPassword.length < 12) {
    throw new Error("SEED_DEMO_PASSWORD with at least 12 characters is required");
  }
  const demoPasswordHash = hashPassword(demoPassword);

  await prisma.user.upsert({
    where: { email: "client@ai-cleaning.local" },
    update: { passwordHash: demoPasswordHash },
    create: {
      name: "Demo Client",
      email: "client@ai-cleaning.local",
      phone: "+70000000001",
      role: Role.CLIENT,
      passwordHash: demoPasswordHash
    }
  });

  await prisma.user.upsert({
    where: { email: "executor@ai-cleaning.local" },
    update: { passwordHash: demoPasswordHash },
    create: {
      name: "Demo Executor",
      email: "executor@ai-cleaning.local",
      phone: "+70000000002",
      role: Role.EXECUTOR,
      passwordHash: demoPasswordHash,
      rating: 4.8,
      distanceKm: 3.2,
      completedOrders: 84
    }
  });

  await prisma.user.upsert({
    where: { email: "operator@ai-cleaning.local" },
    update: { passwordHash: demoPasswordHash },
    create: {
      name: "Demo Operator",
      email: "operator@ai-cleaning.local",
      phone: "+70000000003",
      role: Role.OPERATOR,
      passwordHash: demoPasswordHash
    }
  });

  await prisma.user.upsert({
    where: { email: "admin@ai-cleaning.local" },
    update: { passwordHash: demoPasswordHash },
    create: {
      name: "Demo Admin",
      email: "admin@ai-cleaning.local",
      phone: "+70000000004",
      role: Role.ADMIN,
      passwordHash: demoPasswordHash
    }
  });

  await prisma.user.upsert({
    where: { email: "quality@ai-cleaning.local" },
    update: { passwordHash: demoPasswordHash },
    create: {
      name: "Demo Quality Manager",
      email: "quality@ai-cleaning.local",
      phone: "+70000000005",
      role: Role.QUALITY_MANAGER,
      passwordHash: demoPasswordHash
    }
  });

  await prisma.user.upsert({
    where: { email: "manager@ai-cleaning.local" },
    update: { passwordHash: demoPasswordHash },
    create: {
      name: "Demo Manager",
      email: "manager@ai-cleaning.local",
      phone: "+70000000006",
      role: Role.MANAGER,
      passwordHash: demoPasswordHash
    }
  });
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
