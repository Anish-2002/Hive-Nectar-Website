import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// !!! REPLACE WITH YOUR ACTUAL KEYS !!!
const supabaseUrl = 'https://gxboojbfmpejbjolfmjq.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd4Ym9vamJmbXBlamJqb2xmbWpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzNjU3ODMsImV4cCI6MjA4ODk0MTc4M30.huabAJX_-DYFy06yrvjyBMR_bo6XC43B2O12zHt7Xos';
export const supabase = createClient(supabaseUrl, supabaseKey);