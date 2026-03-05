/**
 * Sends a welcome email by calling our local backend server.
 */
export async function sendWelcomeEmail(userEmail, userName) {
    // Points to your local Node.js server
    const url = 'https://hive-nectar-backend.onrender.com';

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                userEmail: userEmail,
                userName: userName
            })
        });

        const result = await response.json();

        if (result.success) {
            console.log("Success: Server triggered Brevo Template #1!");
        } else {
            console.error("Server reached, but Brevo failed to send.");
        }
    } catch (err) {
        console.error("Could not connect to the server. Did you run 'node server.js'?");
    }

}     


