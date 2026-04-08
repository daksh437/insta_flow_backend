const { getDb } = require('../utils/firestoreAdmin');

function getUid(req) {
  return String(req.headers['x-user-uid'] || req.headers['X-User-UID'] || '').trim();
}

function startOfDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function ymd(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function weekId(date = new Date()) {
  const s = startOfDay(date);
  const day = s.getUTCDay() || 7;
  s.setUTCDate(s.getUTCDate() + (1 - day));
  return ymd(s);
}

function defaultMissionTasks() {
  return [
    { id: 'caption', type: 'caption_generate', completed: false },
    { id: 'hashtag', type: 'hashtag_generate', completed: false },
    { id: 'calendar', type: 'calendar_generate', completed: false },
  ];
}

async function getOrCreateTodayMission(uid) {
  const db = getDb();
  const date = ymd();
  const ref = db.collection('users').doc(uid).collection('daily_missions').doc(date);
  const snap = await ref.get();
  if (!snap.exists) {
    const now = new Date();
    const doc = {
      uid,
      date,
      tasks: defaultMissionTasks(),
      completedCount: 0,
      isCompleted: false,
      rewardGranted: false,
      createdAt: now,
      updatedAt: now,
    };
    await ref.set(doc, { merge: true });
    return { ref, data: doc };
  }
  return { ref, data: snap.data() || {} };
}

async function missionToday(req, res) {
  try {
    const uid = getUid(req);
    if (!uid) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
    const { data } = await getOrCreateTodayMission(uid);
    return res.json({ success: true, mission: data });
  } catch (e) {
    console.error('[Retention] missionToday', e.message);
    return res.status(500).json({ success: false, error: 'Something went wrong, try again' });
  }
}

async function missionView(req, res) {
  try {
    const uid = getUid(req);
    if (!uid) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
    const db = getDb();
    const today = ymd();
    const tool = String(req.body?.tool || '').trim();
    const inputSnippet = String(req.body?.inputSnippet || '').trim().slice(0, 160);
    await db.collection('users').doc(uid).set(
      {
        ...(tool ? { lastUsedTool: tool } : {}),
        ...(inputSnippet ? { lastInputSnippet: inputSnippet } : {}),
        lastUsedAt: new Date(),
        retentionMeta: {
          lastMissionViewDate: today,
          updatedAt: new Date(),
        },
      },
      { merge: true }
    );
    return res.json({ success: true });
  } catch (e) {
    console.error('[Retention] missionView', e.message);
    return res.status(500).json({ success: false, error: 'Something went wrong, try again' });
  }
}

async function missionCompleteTask(req, res) {
  try {
    const uid = getUid(req);
    if (!uid) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
    const taskType = String(req.body?.taskType || '').trim();
    if (!taskType) return res.status(400).json({ success: false, error: 'Invalid taskType' });

    const db = getDb();
    const userRef = db.collection('users').doc(uid);
    const now = new Date();
    const today = ymd();
    const { ref, data } = await getOrCreateTodayMission(uid);
    const tasks = Array.isArray(data.tasks) ? data.tasks : defaultMissionTasks();
    const idx = tasks.findIndex((t) => t.type === taskType);
    if (idx < 0) return res.json({ success: true, mission: data, rewardGrantedNow: false });

    if (tasks[idx].completed === true) return res.json({ success: true, mission: data, rewardGrantedNow: false });
    tasks[idx] = { ...tasks[idx], completed: true };
    const completedCount = tasks.filter((t) => t.completed).length;
    const isCompleted = completedCount >= tasks.length;

    let rewardGrantedNow = false;
    let streakCount = 0;
    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      const user = userSnap.data() || {};
      const prevDate = String(user.lastMissionCompletedDate || '');
      const prevStreak = Number(user.streakCount || 0);
      let nextStreak = prevStreak;

      const missionSnap = await tx.get(ref);
      const missionData = missionSnap.data() || {};
      const alreadyRewarded = missionData.rewardGranted === true;

      tx.set(
        ref,
        {
          tasks,
          completedCount,
          isCompleted,
          updatedAt: now,
        },
        { merge: true }
      );

      if (isCompleted && !alreadyRewarded) {
        rewardGrantedNow = true;
        const yesterday = ymd(new Date(startOfDay(new Date(now.getTime() - 24 * 60 * 60 * 1000))));
        if (prevDate === today) {
          nextStreak = prevStreak;
        } else if (prevDate === yesterday) {
          nextStreak = prevStreak + 1;
        } else {
          nextStreak = 1;
        }
        streakCount = nextStreak;
        tx.set(
          ref,
          {
            rewardGranted: true,
            completedAt: now,
          },
          { merge: true }
        );
        tx.set(
          userRef,
          {
            streakCount: nextStreak,
            lastMissionCompletedDate: today,
            retentionBonusCredits: Math.min(Number(user.retentionBonusCredits || 0) + 1, 10),
            updatedAt: now,
          },
          { merge: true }
        );
      }
    });

    const updated = (await ref.get()).data() || {};
    return res.json({ success: true, mission: updated, rewardGrantedNow, streakCount });
  } catch (e) {
    console.error('[Retention] missionCompleteTask', e.message);
    return res.status(500).json({ success: false, error: 'Something went wrong, try again' });
  }
}

async function recommendations(req, res) {
  try {
    const uid = getUid(req);
    if (!uid) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
    const db = getDb();
    const userSnap = await db.collection('users').doc(uid).get();
    const user = userSnap.data() || {};
    const histSnap = await db
      .collection('ai_history')
      .where('userId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(5)
      .get();

    const recent = histSnap.docs.map((d) => d.data());
    const last = recent[0] || {};
    const lastUsedTool = String(user.lastUsedTool || last.serviceType || 'ai_captions');
    const lastInput = String(user.lastInputSnippet || last.input || '').substring(0, 120);
    const now = new Date();
    const bestPostingWindow = now.getHours() < 12 ? '6:00 PM - 8:00 PM' : '11:00 AM - 1:00 PM';
    const recommendations = [
      'Try a bold hook today for better saves',
      'Post carousel format for higher dwell time',
      'Keep first line under 9 words for attention',
    ];
    return res.json({
      success: true,
      data: {
        continueWhereLeft: { tool: lastUsedTool, inputSnippet: lastInput },
        recommendations,
        bestPostingWindow,
      },
    });
  } catch (e) {
    console.error('[Retention] recommendations', e.message);
    return res.status(500).json({ success: false, error: 'Something went wrong, try again' });
  }
}

async function weeklyReport(req, res) {
  try {
    const uid = getUid(req);
    if (!uid) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
    const db = getDb();
    const wid = weekId();
    const reportRef = db.collection('weekly_reports').doc(`${uid}_${wid}`);
    const existing = await reportRef.get();
    if (existing.exists) {
      return res.json({ success: true, data: existing.data() });
    }

    const since = new Date(startOfDay(new Date()));
    since.setUTCDate(since.getUTCDate() - 7);
    const hist = await db
      .collection('ai_history')
      .where('userId', '==', uid)
      .where('createdAt', '>=', since)
      .get();
    const count = hist.docs.length;
    const toolMap = {};
    hist.docs.forEach((d) => {
      const t = String((d.data() || {}).serviceType || 'unknown');
      toolMap[t] = (toolMap[t] || 0) + 1;
    });
    const topTool = Object.keys(toolMap).sort((a, b) => toolMap[b] - toolMap[a])[0] || 'ai_captions';
    const data = {
      uid,
      weekId: wid,
      summary: `You generated ${count} AI outputs this week.`,
      metrics: { generatedCount: count, topTool, bestPostingWindow: '6:00 PM - 8:00 PM' },
      tip: 'Try posting 30 minutes before your best window for better reach.',
      generatedAt: new Date(),
    };
    await reportRef.set(data, { merge: true });
    return res.json({ success: true, data });
  } catch (e) {
    console.error('[Retention] weeklyReport', e.message);
    return res.status(500).json({ success: false, error: 'Something went wrong, try again' });
  }
}

module.exports = {
  missionToday,
  missionView,
  missionCompleteTask,
  recommendations,
  weeklyReport,
};
