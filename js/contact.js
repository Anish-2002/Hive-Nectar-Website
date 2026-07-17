// contact.js
import { supabase } from './supabase-config.js';
import { showToast } from './app.js';

export async function handleContactSubmit(e) {
    e.preventDefault();
    
    const contactForm = e.target;
    const feedbackArea = document.getElementById('contactFormFeedback');
    
    // Gather data from the form fields defined in contact.html
    const formData = {
        user_name: document.getElementById('userName').value,
        user_email: document.getElementById('userEmail').value,
        category: document.getElementById('contactCategory').value,
        message: document.getElementById('userMessage').value
    };

    // Optional: Attempt to link to a logged-in user if session exists
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
        formData.user_id = user.id;
    }

    // Insert the inquiry into your Supabase table
    const { error } = await supabase.from('contact_inquiries').insert([formData]);

    if (error) {
        showToast("Error sending message: " + error.message, "error");
    } else {
        // Show the success feedback card and hide the form
        contactForm.classList.add('hide');
        feedbackArea.classList.remove('hide');
    }
}