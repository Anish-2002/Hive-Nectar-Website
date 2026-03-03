// email.js
const BREVO_API_KEY = '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';

export async function sendWelcomeEmail(userEmail, userName) {
    const url = 'https://api.brevo.com/v3/smtp/email';
    
    const emailData = {
        sender: { name: "Hive Nectar", email: "follydevs@gmail.com" },
        to: [{ email: userEmail, name: userName }],
        subject: "Welcome to the Hive!",
        // If using a template:
        // templateId: 1, 
        // params: { FIRSTNAME: userName }
        
        // If using plain text/HTML:
        htmlContent: `<h1>Welcome, ${userName}!</h1><p>Thanks for joining Hive Nectar. Get ready to start your missions!</p>`
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'api-key': BREVO_API_KEY,
                'content-type': 'application/json'
            },
            body: JSON.stringify(emailData)
        });

        if (!response.ok) {
            const error = await response.json();
            console.error("Brevo Error:", error);
        } else {
            console.log("Welcome email sent successfully!");
        }
    } catch (err) {
        console.error("Failed to send email:", err);
    }
}