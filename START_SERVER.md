# 🚀 Server Start Guide

## ✅ Fixed Issues

1. ✅ Gemini API key set in `.env` file
2. ✅ Fixed `geminiClient.js` - model parameter corrected
3. ✅ All dependencies installed

## 🎯 Start Server

### Step 1: Open New Terminal
**Fresh PowerShell/CMD window kholo**

### Step 2: Navigate to Backend
```powershell
cd C:\Users\Dell\metapulse_ai\backend
```

### Step 3: Start Server
```powershell
node app.js
```

### Step 4: Expected Output
```
✅ Gemini model initialized: models/gemini-1.5-pro
🚀 InstaFlow backend running on http://localhost:3000
📱 Phone access: http://10.42.138.25:3000
✅ Server ready for requests!
📊 Health check: http://localhost:3000/health
```

## ✅ Verification

### Test Health Endpoint:
```powershell
Invoke-WebRequest -Uri http://localhost:3000/health -UseBasicParsing
```

Expected:
```
StatusCode: 200
Content: {"status":"ok","success":true,"message":"OK"}
```

## 🐛 If Server Doesn't Start

### Check for Errors:
1. Make sure no other process is using port 3000
2. Check terminal for error messages
3. Verify `.env` file exists and has GEMINI_API_KEY

### Kill Existing Node Processes:
```powershell
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
```

Then start again:
```powershell
node app.js
```

---

**Server manually start karo aur terminal output share karo!** 🚀

