/**
 * One-shot migration: assign all pre-existing data to a designated first user.
 *
 * Run AFTER `prisma db push` (which adds the userId columns) and BEFORE
 * letting any other user sign in. Idempotent — safe to run twice.
 *
 * Usage:
 *   FIRST_USER_EMAIL=you@example.com \
 *   FIRST_USER_PASSWORD=changeme123 \
 *   FIRST_USER_NAME="Your Name" \
 *   npx tsx scripts/migrate-to-multiuser.ts
 *
 * What it does:
 *   1. Creates the User row (or finds it if it already exists) with role=ADMIN.
 *   2. Adds the email to EmailAllowlist (so the user can actually sign in).
 *   3. Backfills `userId` on every pre-existing Job / CV / Credential /
 *      ScraperRun / CvAnalysis row to point at this user.
 *   4. Creates a Profile row if missing.
 *
 * After running, sign in with the email + password you set and you should
 * see all your existing CVs, jobs, scraper runs, etc. in the dashboard.
 */

import { PrismaClient } from '@prisma/client'
import { hash } from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  const email = (process.env.FIRST_USER_EMAIL || '').toLowerCase().trim()
  const password = process.env.FIRST_USER_PASSWORD
  const name = process.env.FIRST_USER_NAME || null

  if (!email || !password) {
    console.error('Missing FIRST_USER_EMAIL or FIRST_USER_PASSWORD env vars')
    process.exit(1)
  }
  if (password.length < 8) {
    console.error('FIRST_USER_PASSWORD must be at least 8 characters')
    process.exit(1)
  }

  // 1. Create/find user
  let user = await prisma.user.findUnique({ where: { email } })
  if (user) {
    console.log(`User ${email} already exists (id=${user.id}) — re-using.`)
  } else {
    user = await prisma.user.create({
      data: {
        email,
        passwordHash: await hash(password, 12),
        name,
        role: 'ADMIN',
      },
    })
    console.log(`Created user ${email} (id=${user.id}) with role=ADMIN.`)
  }

  // 2. Allowlist the email
  await prisma.emailAllowlist.upsert({
    where:  { email },
    update: {},
    create: { email, note: 'First / admin user (migration)' },
  })
  console.log(`Allowlisted ${email}.`)

  // 3. Backfill userId on all user-scoped tables.
  // We use updateMany with a where clause that matches anything missing the
  // userId (it'll be null right after `db push` adds the column). Idempotent
  // because subsequent runs match zero rows.
  //
  // NOTE: Prisma doesn't have a "where field is unset" filter for required
  // string columns, so we use a raw SQL update for each table. The userId
  // column was added as nullable in `db push` for this migration to work,
  // then we'll enforce NOT NULL in a follow-up migration after this script
  // runs (or rely on application-level enforcement).
  const tables = ['Job', 'CV', 'Credential', 'ScraperRun', 'CvAnalysis']
  for (const t of tables) {
    const res = await prisma.$executeRawUnsafe(
      `UPDATE "${t}" SET "userId" = $1 WHERE "userId" IS NULL`,
      user.id
    )
    console.log(`Backfilled ${res} rows in ${t}.`)
  }

  // 4. Profile — the old singleton with id="default" is migrated to this user.
  const oldDefault = await prisma.$queryRawUnsafe<any[]>(
    `SELECT * FROM "Profile" WHERE id = 'default' LIMIT 1`
  )
  if (oldDefault.length > 0) {
    const p = oldDefault[0]
    await prisma.profile.upsert({
      where:  { userId: user.id },
      update: {},
      create: {
        userId:              user.id,
        fullName:            p.fullName,
        email:               p.email,
        phone:               p.phone,
        yearsExperience:     p.yearsExperience,
        currentRole:         p.currentRole,
        expectedSalaryLpa:   p.expectedSalaryLpa,
        noticePeriodDays:    p.noticePeriodDays,
        skills:              p.skills || [],
        preferredLocations:  p.preferredLocations || [],
        preferredIndustries: p.preferredIndustries || [],
        remoteOnly:          !!p.remoteOnly,
        minMatchScore:       p.minMatchScore ?? 60,
      },
    })
    console.log(`Migrated Profile (id=default) -> userId=${user.id}.`)
    // Remove the old default row so we don't trip over it
    await prisma.$executeRawUnsafe(`DELETE FROM "Profile" WHERE id = 'default'`)
  } else {
    // No singleton profile existed — just make sure the user has one
    await prisma.profile.upsert({
      where:  { userId: user.id },
      update: {},
      create: { userId: user.id, email, fullName: name },
    })
    console.log(`Created blank Profile for ${email}.`)
  }

  console.log('\nMigration complete. Sign in at /signin with this email + password.')
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
