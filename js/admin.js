// CRM Admin panel – placeholder
// This file is loaded by CRM.html. Add admin dashboard logic here.
import { supabase } from './supabase-config.js';
import { showToast } from './app.js';

console.log('CRM Admin loaded');

// Example: Load contact inquiries
async function loadInquiries() {
  const { data, error } = await supabase
    .from('contact_inquiries')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) { console.error(error); return []; }
  return data;
}

export { loadInquiries };
