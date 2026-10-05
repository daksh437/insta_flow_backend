function buildAiFallback(endpoint = '', body = {}) {
  const tool = String(endpoint || '').toLowerCase();
  const topic = body.topic || body.niche || body.userInput || body.comment || 'your topic';

  // No canned reel script: a template that ignores the user's topic is worse
  // than an honest error. Callers turn null into an error response.
  if (tool.includes('/reels-script')) return null;

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
