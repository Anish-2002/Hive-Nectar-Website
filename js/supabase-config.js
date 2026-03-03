import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// !!! REPLACE WITH YOUR ACTUAL KEYS !!!
const supabaseUrl = 'https://agnvayutrvnpztqpioht.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFnbnZheXV0cnZucHp0cXBpb2h0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NzU5ODcsImV4cCI6MjA4ODA1MTk4N30.2ki7imDfvw35GFsDVzivTDnioOA2xTRjs_7GwRx3--Y';

export const supabase = createClient(supabaseUrl, supabaseKey);