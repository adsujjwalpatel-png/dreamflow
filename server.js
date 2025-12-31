const express = require('express');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(express.json());

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Helper function to get current UTC time
const getCurrentUTCHour = () => {
  const now = new Date();
  return now.getUTCHours() + now.getUTCMinutes() / 60;
};

// Helper function to convert interval string to milliseconds
const intervalToMs = (interval) => {
  if (!interval) return 0;
  
  // Parse PostgreSQL interval format (e.g., "00:05:30" or "1 day 00:05:30")
  const timeMatch = interval.match(/(\d+):(\d+):(\d+\.?\d*)/);
  if (timeMatch) {
    const hours = parseInt(timeMatch[1]);
    const minutes = parseInt(timeMatch[2]);
    const seconds = parseFloat(timeMatch[3]);
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }
  return 0;
};

// Route 1: Get data based on time window
app.get('/api/data/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const currentHour = getCurrentUTCHour();

    // Time windows:
    // 0:00 (midnight) to 20:00 (8 PM) -> Words
    // 20:00 to 20:30 (8:00 PM to 8:30 PM) -> Questions
    // 20:30 to 24:00 (8:30 PM to midnight) -> Rankings

    if (currentHour >= 0 && currentHour < 20) {
      // Reset all user ranks to 0
      await supabase
        .from('users')
        .update({ rank: 0 })
        .neq('email', ''); // Update all users

      // Send words table data
      const { data: words, error } = await supabase
        .from('words')
        .select('*');

      if (error) throw error;

      return res.json({
        type: 'words',
        data: words,
        message: 'Words learning period (12 AM - 8 PM UTC)'
      });

    } else if (currentHour >= 20 && currentHour < 20.5) {
      // Send questions table data
      const { data: questions, error } = await supabase
        .from('questions')
        .select('*');

      if (error) throw error;

      return res.json({
        type: 'questions',
        data: questions,
        message: 'Quiz period (8:00 PM - 8:30 PM UTC)'
      });

    } else {
      // Calculate rankings
      const { data: users, error } = await supabase
        .from('users')
        .select('*')
        .order('number_of_correct_ans', { ascending: false })
        .order('time', { ascending: true });

      if (error) throw error;

      // Assign ranks
      const rankedUsers = users.map((user, index) => ({
        ...user,
        rank: index + 1
      }));

      // Update ranks in database
      for (const user of rankedUsers) {
        await supabase
          .from('users')
          .update({ rank: user.rank })
          .eq('email', user.email);
      }

      // Find current user's data
      const userData = rankedUsers.find(u => u.email === email);

      return res.json({
        type: 'rankings',
        data: {
          user: userData,
          leaderboard: rankedUsers
        },
        message: 'Rankings period (8:30 PM - 12 AM UTC)'
      });
    }

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Route 2: Submit answers
app.post('/api/submit', async (req, res) => {
  try {
    const { email, answers, time } = req.body;

    // Validate input
    if (!email || !answers || !time) {
      return res.status(400).json({ 
        error: 'Missing required fields: email, answers, time' 
      });
    }

    // Get all questions for validation
    const { data: questions, error: questionsError } = await supabase
      .from('questions')
      .select('*');

    if (questionsError) throw questionsError;

    // Calculate correct answers and total time
    let correctCount = 0;
    let totalTimeMs = 0;

    for (const [word, answer] of Object.entries(answers)) {
      const question = questions.find(q => q.word === word);
      
      if (question && question.correct === answer) {
        correctCount++;
      }

      // Add time for this question
      if (time[word]) {
        totalTimeMs += parseFloat(time[word]);
      }
    }

    // Convert total time to PostgreSQL interval format (HH:MM:SS)
    const totalSeconds = Math.floor(totalTimeMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const intervalString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

    // Check if user exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (existingUser) {
      // Get existing time and add to it
      const existingTimeMs = intervalToMs(existingUser.time);
      const newTotalTimeMs = existingTimeMs + totalTimeMs;
      
      const newTotalSeconds = Math.floor(newTotalTimeMs / 1000);
      const newHours = Math.floor(newTotalSeconds / 3600);
      const newMinutes = Math.floor((newTotalSeconds % 3600) / 60);
      const newSeconds = newTotalSeconds % 60;
      const newIntervalString = `${newHours.toString().padStart(2, '0')}:${newMinutes.toString().padStart(2, '0')}:${newSeconds.toString().padStart(2, '0')}`;

      // Update existing user
      const { error: updateError } = await supabase
        .from('users')
        .update({
          number_of_correct_ans: existingUser.number_of_correct_ans + correctCount,
          time: newIntervalString
        })
        .eq('email', email);

      if (updateError) throw updateError;

    } else {
      // Insert new user
      const { error: insertError } = await supabase
        .from('users')
        .insert({
          email,
          number_of_correct_ans: correctCount,
          time: intervalString,
          rank: 0
        });

      if (insertError) throw insertError;
    }

    res.json({
      success: true,
      correctAnswers: correctCount,
      totalQuestions: Object.keys(answers).length,
      timeTaken: intervalString,
      message: 'Answers submitted successfully'
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
