import 'dotenv/config';
import { supabase } from '../src/services/supabase';

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].replace(/^--/, '');
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      parsed[key] = value;
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs();

  const email = args.email || process.env.ADMIN_EMAIL;
  const password = args.password || process.env.ADMIN_PASSWORD;
  const fullName = args.name || args.full_name || 'System Administrator';
  const role = (args.role === 'super_admin' ? 'super_admin' : 'admin') as 'admin' | 'super_admin';

  if (!email || !password) {
    console.error('\n❌ Usage:');
    console.error('  npx ts-node scripts/create-admin.ts --email admin@nooi.com --password YourStrongPassword123! [--name "Admin Name"] [--role admin|super_admin]\n');
    process.exit(1);
  }

  if (password.length < 8) {
    console.error('❌ Password must be at least 8 characters long.');
    process.exit(1);
  }

  console.log(`\nCreating or promoting admin user [${email}] with role [${role}]...`);

  try {
    // 1. Check if user already exists
    const { data: userList, error: listError } = await supabase.auth.admin.listUsers();
    if (listError) {
      throw listError;
    }

    const existingUser = userList.users.find(u => u.email?.toLowerCase() === email.toLowerCase());

    let userId: string;

    if (existingUser) {
      console.log(`User already exists in Supabase Auth (ID: ${existingUser.id}). Promoting to ${role}...`);
      userId = existingUser.id;

      const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
        password,
        user_metadata: {
          ...existingUser.user_metadata,
          full_name: fullName,
          role,
        },
      });

      if (updateError) throw updateError;
    } else {
      console.log(`Creating new user in Supabase Auth...`);
      const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: fullName,
          role,
        },
      });

      if (createError || !newUser.user) {
        throw createError || new Error('Failed to create user');
      }

      userId = newUser.user.id;
    }

    // 2. Upsert profile table
    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({
        id: userId,
        full_name: fullName,
        role,
        updated_at: new Date().toISOString(),
      });

    if (profileError) {
      console.warn(`⚠️ Warning: Could not upsert profiles table: ${profileError.message}`);
      console.warn('   Ensure you have executed the migration script 20260912_roles_and_vendor_tables.sql');
    }

    console.log(`\n✅ Successfully configured administrator:`);
    console.log(`   User ID:   ${userId}`);
    console.log(`   Email:     ${email}`);
    console.log(`   Name:      ${fullName}`);
    console.log(`   Role:      ${role}\n`);
    process.exit(0);

  } catch (err: any) {
    console.error('\n❌ Error creating administrator:', err.message || err);
    process.exit(1);
  }
}

main();
