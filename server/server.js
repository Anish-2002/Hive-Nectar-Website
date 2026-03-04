// server/server.js
require("dotenv").config(); // MUST BE AT THE TOP
const express = require("express");
const axios = require("axios");
const cors = require("cors");

// Now this will correctly show if the key is loaded
console.log("Your Key starts with:", process.env.BREVO_API_KEY ? process.env.BREVO_API_KEY.substring(0, 12) : "STILL UNDEFINED - Check .env file location");

const app = express();
app.use(cors()); 
app.use(express.json());

// ROUTE 1: Send Welcome Email using Brevo Template
app.post("/send-welcome-email", async (req, res) => {
  const { userEmail, userName } = req.body;
  
  try {
    const response = await axios.post("https://api.brevo.com/v3/smtp/email", {
      sender: { name: "Hive Nectar", email: "follydevs@gmail.com" },
      to: [{ email: userEmail, name: userName }],
      templateId: 1, 
      params: { 
          NAME: userName 
      }
    }, {
      headers: { 
        "api-key": process.env.BREVO_API_KEY,
        "Content-Type": "application/json"
      }
    });

    console.log("Email sent successfully to:", userEmail);
    res.json({ success: true });
  } catch (error) {
    // This will print the EXACT reason from Brevo in your terminal
    console.error("Brevo API Error Detail:", error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ROUTE 2: CRM Admin Reply
app.post("/admin-reply", async (req, res) => {
    const { userEmail, message } = req.body;
    try {
      await axios.post("https://api.brevo.com/v3/smtp/email", {
        sender: { name: "Hive Nectar Admin", email: "follydevs@gmail.com" },
        to: [{ email: userEmail }],
        subject: "Reply to your inquiry",
        textContent: message,
      }, {
        headers: { 
            "api-key": process.env.BREVO_API_KEY,
            "Content-Type": "application/json"
        }
      });
      res.json({ success: true });
    } catch (error) {
      console.error("CRM Reply Error:", error.response?.data || error.message);
      res.status(500).json({ success: false });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Hive Server is buzzing on port ${PORT}`));