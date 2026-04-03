# AI Access Enforcement — Hardening Summary

## Goal
If user plan is **free** and **dailyAiUsed >= DAILY_CREDITS_FREE (2)**, then **no AI endpoint** executes — zero exceptions.

---

## Backend

### 1. All POST /ai/* routes + middleware status

| Route | requireAiAccess | wrapAiHandler |
|-------|-----------------|----------------|
| POST /ai/captions | ✓ (router.use) | ✓ |
| POST /ai/image-captions | ✓ | ✓ |
| POST /ai/caption-from-media | ✓ | ✓ |
| POST /ai/calendar | ✓ | ✓ |
| POST /ai/strategy | ✓ | ✓ |
| POST /ai/analyze | ✓ | ✓ |
| POST /ai/reels-script | ✓ | ✓ |
| POST /ai/post-ideas | ✓ | ✓ |
| POST /ai/hashtags | ✓ | ✓ |
| POST /ai/bio | ✓ | ✓ |
| POST /ai/hooks | ✓ | ✓ |
| POST /ai/comment-reply | ✓ | ✓ |
| POST /ai/trends | ✓ | ✓ |
| POST /ai/carousel | ✓ | ✓ |

- **GET /ai/job-status/:jobId** — no AI access check (read-only polling).
- **POST /calendar/create** — not an AI route (Google Calendar API only); no requireAiAccess.
- **GET /daily-drop/today** — read-only; no AI call in route. Cron uses `dailyDropGenerator` (server-side only, documented).

### 2. Routes fixed
- None missing; all POST /ai/* routes already had requireAiAccess via `router.use(aiAccessMiddleware)`. Added **wrapAiHandler** to every AI controller so each handler asserts `req.aiAccessAllowed === true` before running.

### 3. Global safety wrapper: wrapAiHandler(handler)
- **Location:** `backend/middleware/aiAccess.js`
- **Behavior:** Before invoking the handler, checks `req.aiAccessAllowed === true`. If not, returns 403 with `code: DAILY_LIMIT_REACHED` and logs `AI_CONTROLLER_BLOCKED`.
- **Usage:** Every AI controller in `routes/gemini.js` is wrapped: `router.post('/captions', wrapAiHandler(generateCaptions));` etc.

### 4. Runtime proof logs
- **requireAiAccess:** Logs `AI_MIDDLEWARE_HIT` with `{ endpoint, uid, planType, dailyAiUsed }` (JSON). When DEV_SKIP_LIMITS, logs `reason: 'DEV_SKIP_LIMITS'`.
- **Each AI controller:** Logs `AI_CONTROLLER_HIT` with `{ endpoint }` (JSON) at entry.
- **Order:** Middleware runs first (AI_MIDDLEWARE_HIT), then controller (AI_CONTROLLER_HIT) only if allowed.

### 5. Direct Gemini usage
- **geminiController.js:** All `runGemini` / `runGeminiWithImage` calls are inside controllers that are behind requireAiAccess + wrapAiHandler. ✓
- **dailyDropGenerator.js:** Uses `runGemini` only from server cron (no user request). Documented in file: "GUARD CONTEXT: This module is invoked only by server cron, not by user HTTP requests."
- **No other files** call `runGemini` or `generateContent`; no refactor needed.

### 6. DEV_SKIP_LIMITS safety
- **Log when enabled:** On load of `aiAccess.js`, if `DEV_SKIP_LIMITS` is true, logs: `[aiAccess] ⚠️ DEV_SKIP_LIMITS is enabled — AI usage limits are bypassed. Do not use in production.`
- **Production check:** In `app.js` listen callback, if `NODE_ENV === 'production'` and `DEV_SKIP_LIMITS` is true, server logs `[FATAL] DEV_SKIP_LIMITS must not be enabled in production. Aborting.`, closes the server, and `process.exit(1)`.

### 7. Startup assertion
- **auditAiRoutes(app)** runs at server startup (in listen callback). If any POST /ai/* route does not have the tagged requireAiAccess middleware, it throws and the server exits with code 1.

---

## Frontend

### 8. AI buttons / generate actions — runWithBackendAiGuard

| Screen | Change |
|--------|--------|
| ai_strategy_screen | Wrapped `_api.generateStrategy` in `runWithBackendAiGuard`. |
| ai_calendar_screen | Wrapped `_api.generateCalendar` in `runWithBackendAiGuard`. |
| reels_script_screen | Wrapped `_api.generateReelsScript` in `runWithBackendAiGuard`. |
| ai_caption_from_media_screen | Wrapped `_api.generateCaptionFromMedia` in `runWithBackendAiGuard`. |
| hashtag_generator_screen | Replaced `requirePremiumOrTrial` with `runWithBackendAiGuard` around `AIService().generateHashtags` (which uses ApiService). |
| caption_generator_screen | Replaced `requirePremiumOrTrial` with `runWithBackendAiGuard` around `_aiService.generateCaptionStyles`. |
| ai_captions_screen | Already used `runWithBackendAiGuard`. ✓ |
| niche_analysis_screen | Already used `runWithBackendAiGuard`. ✓ |
| ai_tool_base_screen (widget) | Already used `runWithBackendAiGuard`. ✓ |

### 9. ApiService — 403 DAILY_LIMIT_REACHED
- **Already implemented:** In `_post()`, when `res.statusCode == 403` and response body `code == 'DAILY_LIMIT_REACHED'`, throws `DailyLimitReachedException` and does **not** retry (rethrow in catch). ✓

---

## Confirmation

- **Free users with dailyAiUsed >= 2:**  
  - **Backend:** requireAiAccess blocks before controller (strict check `planType === 'free' && dailyAiUsed >= DAILY_CREDITS_FREE`). If that were bypassed, wrapAiHandler would still block because `req.aiAccessAllowed` is only set to `true` when the middleware allows the request.  
  - **Frontend:** All AI generation flows that hit the backend go through `runWithBackendAiGuard`, which calls `checkAiAccess()` and shows the paywall when not allowed; direct API calls that return 403 cause `DailyLimitReachedException` and the guard shows the upgrade dialog.

- **Result:** Free users with dailyAiUsed >= limit cannot reach any AI controller logic; they receive 403 and, on the client, see the premium/upgrade flow.
