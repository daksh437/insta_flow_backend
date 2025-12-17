# InstaFlow Backend

Backend API for InstaFlow - Google OAuth + Calendar + Gemini AI

## 📁 Folder Structure

```
backend/
├── app.js                 # Main Express server
├── package.json           # Dependencies
├── .env.example          # Environment variables template
├── routes/               # API routes
│   ├── auth.js          # Google OAuth routes
│   ├── gemini.js        # AI endpoints
│   └── calendar.js      # Google Calendar routes
├── controllers/          # Route handlers
│   ├── authController.js
│   ├── geminiController.js
│   └── calendarController.js
├── utils/                # Utility functions
│   ├── oauthClient.js
│   ├── tokenStore.js
│   ├── geminiClient.js
│   └── imageProcessor.js
└── data/                 # Data storage
    └── tokens.json       # OAuth tokens (auto-created)
```

## 🚀 Quick Start (Local Development)

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Setup Environment Variables

Create a `.env` file in the `backend` directory:

```env
PORT=3000
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback
GEMINI_API_KEY=your_gemini_api_key
CORS_ORIGINS=http://localhost:5173,http://localhost:3000
NODE_ENV=development
```

### 3. Start Server

```bash
npm start
```

Server will run on `http://localhost:3000`

## ☁️ Cloud Deployment (Render)

### Prerequisites

1. **GitHub Repository**: Push your backend code to GitHub
2. **Render Account**: Sign up at [render.com](https://render.com)
3. **API Keys**: Get your Google OAuth credentials and Gemini API key

### Step-by-Step Deployment

#### 1. Create New Web Service on Render

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repository
4. Select the repository containing your backend

#### 2. Configure Build Settings

- **Name**: `instaflow-backend` (or your preferred name)
- **Environment**: `Node`
- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Root Directory**: `backend` (if backend is in a subdirectory)

#### 3. Set Environment Variables

In Render dashboard, go to **Environment** section and add:

```env
PORT=10000
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_google_client_secret_here
GOOGLE_REDIRECT_URI=https://your-app-name.onrender.com/auth/callback
GEMINI_API_KEY=your_gemini_api_key_here
NODE_ENV=production
CORS_ORIGINS=*
```

**Important Notes:**
- `PORT` is automatically set by Render (usually `10000`), but you can keep it as fallback
- Replace `your-app-name.onrender.com` with your actual Render service URL
- Update `GOOGLE_REDIRECT_URI` in Google Cloud Console to match your Render URL
- `CORS_ORIGINS=*` allows all origins (or specify your Flutter app's domain)

#### 4. Update Google OAuth Redirect URI

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Navigate to **APIs & Services** → **Credentials**
3. Edit your OAuth 2.0 Client ID
4. Add authorized redirect URI: `https://your-app-name.onrender.com/auth/callback`
5. Save changes

#### 5. Deploy

1. Click **"Create Web Service"**
2. Render will automatically:
   - Clone your repository
   - Run `npm install`
   - Start your server with `npm start`
3. Wait for deployment to complete (usually 2-3 minutes)
4. Your backend will be live at: `https://your-app-name.onrender.com`

### 6. Verify Deployment

1. Check health endpoint: `https://your-app-name.onrender.com/health`
2. Should return: `{"status":"ok","success":true,"message":"OK"}`

## 📡 API Endpoints

### Health Check
- `GET /health` - Server health check

### Google OAuth
- `GET /auth/url` - Get OAuth URL
- `GET /auth/callback` - OAuth callback
- `GET /auth/status` - Check connection status

### AI Endpoints
- `POST /ai/captions` - Generate Instagram captions
- `POST /ai/calendar` - Generate content calendar
- `POST /ai/strategy` - Generate growth strategy
- `POST /ai/analyze` - Analyze niche

### Google Calendar
- `POST /calendar/create` - Create calendar event

## 🔧 Configuration

### Environment Variables (Required)

| Variable | Description | Example |
|----------|-------------|---------|
| `PORT` | Server port (auto-set by Render) | `10000` |
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID | `xxx.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret | `GOCSPX-xxx` |
| `GOOGLE_REDIRECT_URI` | OAuth callback URL | `https://your-app.onrender.com/auth/callback` |
| `GEMINI_API_KEY` | Google Gemini API key | `AIzaSy...` |
| `NODE_ENV` | Environment mode | `production` or `development` |
| `CORS_ORIGINS` | Allowed CORS origins (optional, defaults to `*`) | `*` or `https://example.com` |

### Port Configuration

- **Local**: Defaults to `3000` if `PORT` not set
- **Render**: Automatically sets `PORT` (usually `10000`)
- Server listens on `0.0.0.0` to accept connections from all network interfaces

### CORS Configuration

- If `CORS_ORIGINS` is not set, all origins are allowed (`*`)
- For production, you can restrict to specific domains:
  ```env
  CORS_ORIGINS=https://your-flutter-app.com,https://your-web-app.com
  ```

## 📝 Notes

- **OAuth Tokens**: Stored in `data/tokens.json` (file-based, consider database for production)
- **Mock Data**: Returns mock data if API keys are not set (for testing)
- **Server Binding**: Listens on `0.0.0.0` to allow access from all network interfaces
- **Production Mode**: Set `NODE_ENV=production` for optimized logging

## 🔒 Security Best Practices

1. **Never commit `.env` file** to Git
2. **Use environment variables** for all sensitive data
3. **Enable HTTPS** on Render (automatic with free tier)
4. **Restrict CORS origins** in production if possible
5. **Rotate API keys** regularly

## 🐛 Troubleshooting

### Backend not starting on Render

1. Check **Logs** tab in Render dashboard
2. Verify all environment variables are set
3. Ensure `package.json` has `start` script
4. Check Node.js version compatibility (requires Node 16+)

### CORS errors in Flutter app

1. Update `baseUrl` in Flutter app to your Render URL
2. Verify `CORS_ORIGINS` is set correctly
3. Check that backend is running and accessible

### OAuth redirect errors

1. Ensure `GOOGLE_REDIRECT_URI` matches exactly in:
   - Render environment variables
   - Google Cloud Console authorized redirect URIs
2. URL must be HTTPS in production

## 📞 Support

For issues or questions, check the logs in Render dashboard or local terminal output.
