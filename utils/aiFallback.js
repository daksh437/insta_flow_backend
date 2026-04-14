function buildAiFallback(endpoint = '', body = {}) {
  const tool = String(endpoint || '').toLowerCase();
  const topic = body.topic || body.niche || body.userInput || body.comment || 'your topic';

  if (tool.includes('/reels-script')) {
    return {
      hook: 'Stop scrolling! This one tweak can boost your engagement 🚀',
      scenes: [
        { time: '0-3s', line: 'Show the problem clearly.' },
        { time: '3-10s', line: 'Explain one practical fix.' },
        { time: '10-15s', line: 'Give a strong CTA.' },
      ],
      cta: 'Save this and follow for more growth ideas.',
      caption: `Quick reel framework for ${topic}`.trim(),
      hashtags: ['#reels', '#instagrowth', '#viral'],
      aiScore: 78,
      suggestions: ['Add stronger hook', 'Use short cuts', 'Keep CTA specific'],
    };
  }

  if (tool.includes('/hashtags') || tool.includes('/trends')) {
    return {
      primary: ['#instagram', '#contentcreator', '#reels'],
      growth: ['#socialmedia', '#instatips', '#creatorlife'],
      niche: ['#smallcreator', '#growthmindset', '#contentideas'],
      score: 74,
      aiScore: 74,
    };
  }

  if (tool.includes('/post-ideas')) {
    return {
      ideas: [
        { title: '3 mistakes people make', angle: 'educational' },
        { title: 'Before vs after process', angle: 'story' },
        { title: 'One framework that works', angle: 'actionable' },
      ],
      aiScore: 76,
    };
  }

  if (tool.includes('/strategy')) {
    return {
      sections: [
        { title: 'Audience', bullets: ['Define ICP', 'Map pain points'] },
        { title: 'Content Plan', bullets: ['3 pillars', '4 posts/week'] },
        { title: 'Optimization', bullets: ['A/B hook testing', 'Retention tracking'] },
      ],
      aiScore: 80,
    };
  }

  return {
    result: `Starter output for ${topic}`,
    suggestions: ['Regenerate for refinement', 'Add CTA', 'Keep lines short'],
    aiScore: 70,
  };
}

module.exports = { buildAiFallback };
