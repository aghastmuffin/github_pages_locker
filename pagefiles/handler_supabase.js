import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient('https://cahitfvxroazudhoiixa.supabase.co', 'sb_publishable_XYm-dyC0_ny5NtpTSltLKA_ptuSD9TV')

// generate 3-char session ID if you want
let session_id = localStorage.getItem('session_id')
if (!session_id) {
  session_id = Math.random().toString(36).substring(2, 5)
  localStorage.setItem('session_id', session_id)
}
async function logEvent(type, value, question_id = null) {
  await supabase.from('events').insert({
    session_id,
    type,
    value,
    question_id
  })
}

// Example usage
logEvent('click', 'D', 'q1')
logEvent('visibility', document.hidden ? 'hidden' : 'visible')