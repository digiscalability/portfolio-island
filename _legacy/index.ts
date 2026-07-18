import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

admin.initializeApp();

// AI Q&A Function (connects to Gemini API)
export const askAI = functions.https.onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    const { message } = req.body;

    if (!message) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    // TODO: Integrate with Gemini API
    // Example:
    // const GEMINI_API_KEY = functions.config().gemini.apikey;
    // const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({
    //     contents: [{ parts: [{ text: message }] }]
    //   })
    // });
    // const data = await response.json();
    // const aiResponse = data.candidates[0].content.parts[0].text;

    // Placeholder response
    const aiResponse = `Thank you for your question: "${message}". This is a placeholder response. Please configure the Gemini API to enable AI responses.`;

    // Store conversation in Firestore
    await admin.firestore().collection('conversations').add({
      userMessage: message,
      aiResponse,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ response: aiResponse });
  } catch (error) {
    console.error('Error in askAI function:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Appointment Scheduling Function (integrates with Google Calendar API)
export const scheduleAppointment = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    const { name, email, date, time, duration, notes } = req.body;

    if (!name || !email || !date || !time) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    // TODO: Integrate with Google Calendar API
    // Example using Firebase Extensions or direct API call
    // const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    // const event = {
    //   summary: `Appointment with ${name}`,
    //   description: notes,
    //   start: { dateTime: `${date}T${time}:00`, timeZone: 'UTC' },
    //   end: { dateTime: calculateEndTime(date, time, duration), timeZone: 'UTC' },
    //   attendees: [{ email }],
    // };
    // await calendar.events.insert({ calendarId: 'primary', resource: event });

    // Store appointment in Firestore
    const appointmentRef = await admin.firestore().collection('appointments').add({
      name,
      email,
      date,
      time,
      duration: duration || 30,
      notes: notes || '',
      status: 'pending',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    // TODO: Send confirmation email via Firebase Extensions or SendGrid

    res.json({
      success: true,
      appointmentId: appointmentRef.id,
      message: 'Appointment scheduled successfully',
    });
  } catch (error) {
    console.error('Error in scheduleAppointment function:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Feedback Submission Function
export const submitFeedback = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    const { name, email, message, rating } = req.body;

    if (!name || !email || !message) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    // Store feedback in Firestore
    const feedbackRef = await admin.firestore().collection('feedback').add({
      name,
      email,
      message,
      rating: rating || null,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    // TODO: Send notification to owner via FCM or email

    res.json({
      success: true,
      feedbackId: feedbackRef.id,
      message: 'Feedback submitted successfully',
    });
  } catch (error) {
    console.error('Error in submitFeedback function:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Available Slots Function
export const getAvailableSlots = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    const { date } = req.query;

    if (!date) {
      res.status(400).json({ error: 'Date parameter is required' });
      return;
    }

    // TODO: Query Google Calendar API for available slots
    // Placeholder available slots
    const availableSlots = [
      '09:00', '10:00', '11:00', '14:00', '15:00', '16:00'
    ];

    res.json({ slots: availableSlots });
  } catch (error) {
    console.error('Error in getAvailableSlots function:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

