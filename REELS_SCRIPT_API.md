# Instagram Reels Script API

## Endpoint
**POST** `/ai/reels-script`

## Request Body
```json
{
  "topic": "Morning routine",
  "duration": "15s",  // Options: "15s" | "30s" | "60s"
  "tone": "Motivational",  // Options: "Funny" | "Motivational" | "Attitude" | "Emotional" | "Aesthetic"
  "audience": "Creator",  // Options: "Creator" | "Business" | "Personal"
  "language": "English"  // Options: "English" | "Hinglish" | "Hindi"
}
```

## Response Format
```json
{
  "success": true,
  "data": {
    "hook": "Stop scrolling! This morning routine changed everything",
    "scenes": [
      {
        "duration": "0-3s",
        "voiceover": "Stop scrolling! This morning routine changed everything",
        "on_screen_text": "Game changer"
      },
      {
        "duration": "3-7s",
        "voiceover": "Here's what I do every morning",
        "on_screen_text": "Step 1"
      },
      {
        "duration": "7-11s",
        "voiceover": "First, I wake up at 5 AM",
        "on_screen_text": "5 AM"
      },
      {
        "duration": "11-15s",
        "voiceover": "Try it and thank me later",
        "on_screen_text": "Save this"
      }
    ],
    "cta": "Save this post and try it tomorrow",
    "caption": "This morning routine changed my life. Try it and see the difference! 🌅",
    "hashtags": ["#reels", "#viral", "#instagram", "#growth", "#success", "#motivation", "#trending", "#fyp", "#explore", "#content"]
  }
}
```

## Features

### 1. **Fast & Stable**
- Max tokens: 600 (optimized for speed)
- Hard timeout: 25 seconds (never blocks longer)
- Always returns fallback if Gemini fails
- Never crashes server

### 2. **Scene Count Based on Duration**
- 15s → 4 scenes
- 30s → 6 scenes
- 60s → 8 scenes

### 3. **Language Support**
- English: Pure English content
- Hinglish: Natural Hindi + English mix
- Hindi: Pure Hindi (Devanagari script)

### 4. **Tone Styles**
- Funny: Playful, humorous 😄
- Motivational: Inspiring, empowering 🚀
- Attitude: Bold, confident 💪
- Emotional: Heartfelt, intimate ❤️
- Aesthetic: Calm, poetic ✨

### 5. **Error Handling**
- Always returns `success: true`
- Fallback script if Gemini fails
- Never returns empty data
- Server never crashes

## Example Usage

### cURL
```bash
curl -X POST http://localhost:3000/ai/reels-script \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "Productivity tips",
    "duration": "30s",
    "tone": "Motivational",
    "audience": "Creator",
    "language": "English"
  }'
```

### JavaScript
```javascript
const response = await fetch('http://localhost:3000/ai/reels-script', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    topic: 'Productivity tips',
    duration: '30s',
    tone: 'Motivational',
    audience: 'Creator',
    language: 'English'
  })
});

const data = await response.json();
console.log(data.data.hook); // "Stop scrolling!..."
console.log(data.data.scenes.length); // 6 scenes for 30s
```

## Implementation Details

### Controller Function
Located in: `backend/controllers/geminiController.js`
- Function: `generateReelsScript(req, res)`
- Timeout: 25 seconds (hard limit)
- Max tokens: 600
- Fallback: Always available

### Prompt Function
Located in: `backend/controllers/geminiController.js`
- Function: `createReelsScriptPrompt(topic, duration, tone, audience, language)`
- Optimized for 600 tokens
- Scene count calculated dynamically
- Language and tone strictly enforced

### Fallback Function
Located in: `backend/controllers/geminiController.js`
- Function: `getSimpleFallbackScript(language, topic, duration)`
- Language-specific fallback
- Scene count matches duration
- Always returns valid JSON

## Production Ready ✅
- ✅ No background jobs
- ✅ No queues
- ✅ Simple and fast
- ✅ Never blocks > 25s
- ✅ Always returns data
- ✅ Never crashes

