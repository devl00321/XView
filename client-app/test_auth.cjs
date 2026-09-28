require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function test() {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: 'rikkhan065@gmail.com',
    password: '123456'
  });
  console.log('Login:', error ? error.message : 'Success');
  
  if (data?.session) {
    const res = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    console.log('MFA response:', res);
  }
}
test();
