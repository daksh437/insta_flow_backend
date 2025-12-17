require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Timeout configuration
const REQUEST_TIMEOUT = 30000; // 30 seconds

/**
 * Fetch Instagram profile JSON using Scraper API provider
 */
async function fetchInstagramJSON(username, scraperApiKey) {
  try {
    const scraperUrl = `https://api.scraperapi.com/?api_key=${scraperApiKey}&url=https://www.instagram.com/${username}/`;
    
    const response = await axios.get(scraperUrl, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    return response.data;
  } catch (error) {
    console.error('Scraper API error:', error.message);
    throw new Error(`Scraper API failed: ${error.message}`);
  }
}

/**
 * Extract shared data from HTML using cheerio
 */
function extractSharedDataFromHtml(html) {
  try {
    const $ = cheerio.load(html);
    const scripts = $('script');
    
    for (let i = 0; i < scripts.length; i++) {
      const scriptContent = $(scripts[i]).html();
      if (scriptContent && scriptContent.includes('window._sharedData')) {
        const match = scriptContent.match(/window\._sharedData\s*=\s*({.+?});/);
        if (match && match[1]) {
          return JSON.parse(match[1]);
        }
      }
    }
    
    throw new Error('Could not find _sharedData in HTML');
  } catch (error) {
    console.error('HTML parsing error:', error.message);
    throw new Error(`Failed to parse HTML: ${error.message}`);
  }
}

/**
 * Normalize data to return consistent profile object
 */
function normalizeData(data) {
  try {
    const user = data?.entry_data?.ProfilePage?.[0]?.graphql?.user || 
                 data?.graphql?.user || 
                 {};

    const profile = {
      id: user.id || null,
      username: user.username || null,
      full_name: user.full_name || '',
      biography: user.biography || '',
      followers: user.edge_followed_by?.count || 0,
      following: user.edge_follow?.count || 0,
      posts_count: user.edge_owner_to_timeline_media?.count || 0,
      profile_pic: user.profile_pic_url_hd || user.profile_pic_url || '',
      top_posts: [],
      avg_likes: 0,
      engagement_rate: 0,
    };

    // Extract top posts
    const edges = user.edge_owner_to_timeline_media?.edges || [];
    profile.top_posts = edges.slice(0, 12).map(edge => {
      const node = edge.node || {};
      const likes = node.edge_liked_by?.count || node.edge_media_preview_like?.count || 0;
      const comments = node.edge_media_to_comment?.count || 0;
      
      return {
        id: node.id || null,
        shortcode: node.shortcode || null,
        caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
        is_video: node.is_video || false,
        likes: likes,
        comments: comments,
        thumbnail: node.display_url || node.thumbnail_src || '',
        timestamp: node.taken_at_timestamp || null,
        views: node.video_view_count || null,
      };
    });

    // Calculate average likes and engagement rate
    if (profile.top_posts.length > 0) {
      const totalLikes = profile.top_posts.reduce((sum, post) => sum + (post.likes || 0), 0);
      profile.avg_likes = Math.round(totalLikes / profile.top_posts.length);
      
      if (profile.followers > 0) {
        const totalEngagement = profile.top_posts.reduce(
          (sum, post) => sum + (post.likes || 0) + (post.comments || 0),
          0
        );
        const avgEngagement = totalEngagement / profile.top_posts.length;
        profile.engagement_rate = ((avgEngagement / profile.followers) * 100).toFixed(2);
      }
    }

    return profile;
  } catch (error) {
    console.error('Data normalization error:', error.message);
    throw new Error(`Failed to normalize data: ${error.message}`);
  }
}

/**
 * Main analyze endpoint
 */
app.get('/api/analyze', async (req, res) => {
  const username = req.query.username?.trim();

  if (!username) {
    return res.status(400).json({
      ok: false,
      error: 'Username parameter is required',
    });
  }

  // Validate username format (alphanumeric, dots, underscores)
  if (!/^[a-zA-Z0-9._]+$/.test(username)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid username format',
    });
  }

  try {
    let html;
    const scraperApiKey = process.env.SCRAPER_API_KEY;

    if (scraperApiKey) {
      // Use Scraper API
      console.log(`[${username}] Using Scraper API`);
      html = await fetchInstagramJSON(username, scraperApiKey);
    } else {
      // Fallback to direct fetch with polite headers
      console.log(`[${username}] Using direct fetch`);
      const response = await axios.get(`https://www.instagram.com/${username}/`, {
        timeout: REQUEST_TIMEOUT,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });
      html = response.data;
    }

    const sharedData = extractSharedDataFromHtml(html);
    const profile = normalizeData(sharedData);

    if (!profile.username) {
      return res.status(404).json({
        ok: false,
        error: 'Profile not found or private',
      });
    }

    res.json({
      ok: true,
      profile,
    });
  } catch (error) {
    console.error(`[${username}] Error:`, error.message);
    
    const statusCode = error.response?.status === 404 ? 404 : 500;
    res.status(statusCode).json({
      ok: false,
      error: error.message || 'Internal server error',
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ ok: true, message: 'Server is running' });
});

app.listen(PORT, () => {
  console.log(`🚀 Insta Analyzer backend running on port ${PORT}`);
  console.log(`📡 API endpoint: http://localhost:${PORT}/api/analyze?username=<username>`);
  if (!process.env.SCRAPER_API_KEY) {
    console.log('⚠️  SCRAPER_API_KEY not set, using direct fetch (may be rate-limited)');
  }
});

