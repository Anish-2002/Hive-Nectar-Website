// contact.js
import { supabase } from './supabase-config.js';
import { showToast } from './app.js';
import { getConfig, sendEmail } from './config.js';

export async function handleContactSubmit(e) {
    e.preventDefault();
    
    const contactForm = e.target;
    const feedbackArea = document.getElementById('contactFormFeedback');
    
    // Gather data from the form fields with null safety
    const $ = id => document.getElementById(id);
    const userName = $('userName');
    const userEmail = $('userEmail');
    const contactCategory = $('contactCategory');
    const userMessage = $('userMessage');
    
    if (!userName || !userEmail || !contactCategory || !userMessage) {
        showToast("Form fields not found. Please refresh the page.", "error");
        return;
    }
    
    const formData = {
        user_name: userName.value,
        user_email: userEmail.value,
        category: contactCategory.value,
        message: userMessage.value
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
        if (contactForm) contactForm.classList.add('hide');
        if (feedbackArea) feedbackArea.classList.remove('hide');

        // Send notification email to admin
        const notifyEnabled = await getConfig('notify_contact');
        if (notifyEnabled !== 'false') {
            const notificationEmail = await getConfig('notification_email') || 'follydevs@gmail.com';
            const siteUrl = await getConfig('site_url') || 'https://hivernectar.earth';
            await sendEmail(
                notificationEmail,
                `Contact Form: ${formData.category} from ${formData.user_name}`,
                `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
                    <h2 style="color:#C8A96E;">New Contact Inquiry</h2>
                    <table style="width:100%;border-collapse:collapse;">
                        <tr><td style="padding:8px 0;font-weight:600;color:#7A6B5D;">From:</td><td>${formData.user_name}</td></tr>
                        <tr><td style="padding:8px 0;font-weight:600;color:#7A6B5D;">Email:</td><td>${formData.user_email}</td></tr>
                        <tr><td style="padding:8px 0;font-weight:600;color:#7A6B5D;">Category:</td><td>${formData.category}</td></tr>
                    </table>
                    <hr style="border:none;border-top:1px solid #e0d5c0;margin:16px 0;">
                    <p style="white-space:pre-wrap;">${formData.message}</p>
                    <hr style="border:none;border-top:1px solid #e0d5c0;margin:16px 0;">
                    <p style="font-size:0.85rem;color:#7A6B5D;">
                        <a href="${siteUrl}/admin-crm.html" style="color:#C8A96E;">View in Admin CRM →</a>
                    </p>
                </div>`,
            );
        }
    }
}
