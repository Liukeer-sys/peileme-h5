import bcrypt from "bcryptjs";
import { closePool, query } from "./db.js";
import { runMigrations } from "./migrate.js";
import { seedPolicyFoundation } from "./modules/policy/seed.js";

export const seed = async () => {
  await runMigrations();
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    if (password.length < 10) throw new Error("ADMIN_PASSWORD must contain at least 10 characters");
    const passwordHash = await bcrypt.hash(password, 12);
    await query(
      `INSERT INTO users
         (email, display_name, password_hash, role, email_verified_at)
       VALUES ($1, '赔了么管理员', $2, 'admin', now())
       ON CONFLICT (lower(email)) WHERE email IS NOT NULL
       DO UPDATE SET password_hash = EXCLUDED.password_hash,
                     role = 'admin',
                     status = 'active',
                     updated_at = now()`,
      [email, passwordHash]
    );
    console.log(`Admin account ensured for ${email}`);
  }

  const bootstrapInvite = process.env.BOOTSTRAP_INVITE_CODE?.trim().toUpperCase();
  if (bootstrapInvite) {
    await query(
      `INSERT INTO invite_codes(code, description, max_uses)
       VALUES ($1, '生产环境初始邀请码', 100)
       ON CONFLICT (code) DO NOTHING`,
      [bootstrapInvite]
    );
    console.log("Bootstrap invite ensured");
  }

  await seedPolicyFoundation();
  console.log("Policy foundation ensured");
};

if (process.argv[1]?.endsWith("seed.ts") || process.argv[1]?.endsWith("seed.js")) {
  seed()
    .then(() => closePool())
    .catch(async (error) => {
      console.error(error);
      await closePool();
      process.exitCode = 1;
    });
}
