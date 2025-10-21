import type { Request, Response } from 'express';
import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

admin.initializeApp();

// AI Q&A Function (connects to Gemini API)
export const askAI = functions.https.onRequest(async (req: Request, res: Response) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

    // Gemini API Integration
    const GEMINI_API_KEY = functions.config().gemini?.apikey;

    let aiResponse: string;

    if (GEMINI_API_KEY) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: message }] }]
            })
          }
        );
        const data = await response.json();
        aiResponse = data.candidates?.[0]?.content?.parts?.[0]?.text ||
                     'Sorry, I could not generate a response.';
      } catch (apiError) {
        console.error('Gemini API error:', apiError);
        aiResponse = `Thank you for your question: "${message}". AI is currently unavailable.`;
      }
    } else {
      // Placeholder response when API key not configured
      aiResponse = `Thank you for your question: "${message}". This is a placeholder response. Configure the Gemini API with: firebase functions:config:set gemini.apikey="YOUR_KEY"`;
    }

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

// Appointment Scheduling Function
export const scheduleAppointment = functions.https.onRequest(async (req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

    // TODO: Integrate with Google Calendar API via Firebase Extensions
    // Install: firebase ext:install googlecalendar-calendar-events

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
export const submitFeedback = functions.https.onRequest(async (req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
      read: false,
    });

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
export const getAvailableSlots = functions.https.onRequest(async (req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

    // Get booked appointments for the date
    const appointments = await admin.firestore()
      .collection('appointments')
      .where('date', '==', date)
      .where('status', '==', 'confirmed')
      .get();

    const bookedTimes = appointments.docs.map(doc => doc.data().time);

    // Generate available slots (9 AM - 5 PM, hourly)
    const allSlots = [
      '09:00', '10:00', '11:00', '12:00',
      '13:00', '14:00', '15:00', '16:00', '17:00'
    ];

    const availableSlots = allSlots.filter(slot => !bookedTimes.includes(slot));

    res.json({ slots: availableSlots });
  } catch (error) {
    console.error('Error in getAvailableSlots function:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
