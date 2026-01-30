import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import * as cheerio from 'cheerio';
import { URL } from 'url';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

// ============ SECURITY: Rate Limiting ============
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 10; // 10 requests per minute per IP

function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
  const now = Date.now();
  
  if (!rateLimits.has(ip)) {
    rateLimits.set(ip, { count: 1, windowStart: now });
    return next();
  }
  
  const limit = rateLimits.get(ip);
  if (now - limit.windowStart > RATE_LIMIT_WINDOW) {
    limit.count = 1;
    limit.windowStart = now;
    return next();
  }
  
  limit.count++;
  if (limit.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ 
      error: 'Too Many Requests', 
      message: 'Rate limit exceeded. Try again later.',
      retryAfter: Math.ceil((limit.windowStart + RATE_LIMIT_WINDOW - now) / 1000)
    });
  }
  
  next();
}

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, limit] of rateLimits) {
    if (now - limit.windowStart > RATE_LIMIT_WINDOW * 2) {
      rateLimits.delete(ip);
    }
  }
}, 60000);

// ============ SECURITY: URL Validation ============
const BLOCKED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'metadata.google.internal',
  '169.254.169.254', // AWS/GCP metadata
];

const BLOCKED_IP_RANGES = [
  /^127\./,           // Loopback
  /^10\./,            // Private Class A
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private Class B
  /^192\.168\./,      // Private Class C
  /^169\.254\./,      // Link-local
  /^fc00:/i,          // IPv6 private
  /^fe80:/i,          // IPv6 link-local
];

function isUrlSafe(urlString) {
  try {
    const url = new URL(urlString);
    
    // Must be http or https
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { safe: false, reason: 'Only HTTP/HTTPS allowed' };
    }
    
    // Check blocked hosts
    const hostname = url.hostname.toLowerCase();
    if (BLOCKED_HOSTS.includes(hostname)) {
      return { safe: false, reason: 'Blocked host' };
    }
    
    // Check blocked IP ranges
    for (const pattern of BLOCKED_IP_RANGES) {
      if (pattern.test(hostname)) {
        return { safe: false, reason: 'Internal IP not allowed' };
      }
    }
    
    // Block common internal hostnames
    if (hostname.endsWith('.internal') || 
        hostname.endsWith('.local') ||
        hostname.includes('metadata')) {
      return { safe: false, reason: 'Internal hostname not allowed' };
    }
    
    return { safe: true };
  } catch (e) {
    return { safe: false, reason: 'Invalid URL' };
  }
}

// ============ CONFIGURATION ============
const WALLETS = {
  evm: process.env.EVM_WALLET || '0x884428a7e667A8AC04EF904Ad8ec75E55bbC9Ad7',
  cardano: process.env.CARDANO_WALLET || 'addr_test1qr02ugx4tngn8uc5e5v8mtu2fpfprms4u6uzy0vvtgknudzkrj73vaz964ac2s5qm8rs7l05hq0vngcx0gpsxj0rzxzs7paafj'
};

const PRICING = {
  'web-research-quick': 5,
  'web-research-deep': 10,
  'hitl-simple': 20,
  'hitl-medium': 35,
  'hitl-complex': 50,
  'web-scrape-single': 3,
  'web-scrape-multi': 8
};

// In-memory job store for HITL requests
const hitlJobs = new Map();

// ============ x402 PAYMENT FUNCTIONS ============
function getPaymentRequirements(service, amount) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453', // Base mainnet
        maxAmountRequired: String(amount * 1000000),
        resource: `https://nox-agent-service-production.up.railway.app/${service}`,
        description: `Nox Agent - ${service}`,
        mimeType: 'application/json',
        payTo: WALLETS.evm,
        maxTimeoutSeconds: 300,
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' // USDC on Base
      },
      {
        scheme: 'exact',
        network: 'eip155:84532', // Base Sepolia testnet
        maxAmountRequired: String(amount * 1000000),
        resource: `https://nox-agent-service-production.up.railway.app/${service}`,
        description: `Nox Agent - ${service}`,
        mimeType: 'application/json',
        payTo: WALLETS.evm,
        maxTimeoutSeconds: 300,
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' // USDC on Base Sepolia
      }
    ],
    facilitatorUrl: process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator'
  };
}

// Verify payment with x402 facilitator
async function verifyPayment(paymentHeader, expectedAmount, resource) {
  // TESTNET MODE: Skip verification entirely for testing
  if (process.env.TESTNET_MODE === 'true') {
    console.log('TESTNET MODE: Bypassing payment verification');
    return { valid: true, testnet: true };
  }
  
  const facilitatorUrl = process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator';
  
  try {
    // Parse the payment header (base64 encoded JSON)
    let paymentData;
    try {
      paymentData = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
    } catch (e) {
      // Try as plain JSON
      try {
        paymentData = JSON.parse(paymentHeader);
      } catch (e2) {
        return { valid: false, reason: 'Invalid payment header format' };
      }
    }
    
    // Call facilitator to verify
    const verifyResponse = await fetch(`${facilitatorUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment: paymentData,
        expectedAmount: String(expectedAmount * 1000000),
        resource: resource,
        payTo: WALLETS.evm
      }),
      signal: AbortSignal.timeout(10000) // 10 second timeout
    });
    
    if (!verifyResponse.ok) {
      return { valid: false, reason: 'Payment verification failed' };
    }
    
    const result = await verifyResponse.json();
    return { valid: result.valid === true, txHash: result.txHash };
    
  } catch (err) {
    console.error('Payment verification error:', err.message);
    return { valid: false, reason: 'Payment verification unavailable' };
  }
}

// x402 middleware with real verification
function x402Middleware(serviceName, priceUSD) {
  return async (req, res, next) => {
    const paymentHeader = req.headers['x-payment'];
    
    if (!paymentHeader) {
      return res.status(402).json({
        error: 'Payment Required',
        message: `This service costs $${priceUSD} USD`,
        paymentRequirements: getPaymentRequirements(serviceName, priceUSD),
        paymentOptions: {
          x402: getPaymentRequirements(serviceName, priceUSD),
          masumi: {
            endpoint: process.env.MASUMI_PAYMENT_URL,
            agentId: 'cml1fwd6l000c5cmhr2b6ooi5'
          },
          cardano: {
            wallet: WALLETS.cardano,
            amount: Math.ceil(priceUSD * 3) + ' ADA'
          }
        }
      });
    }

    // Verify the payment
    const resource = `https://nox-agent-service-production.up.railway.app/${serviceName}`;
    const verification = await verifyPayment(paymentHeader, priceUSD, resource);
    
    if (!verification.valid) {
      return res.status(402).json({
        error: 'Payment Invalid',
        message: verification.reason || 'Payment verification failed',
        paymentRequirements: getPaymentRequirements(serviceName, priceUSD)
      });
    }
    
    // Log successful payment
    console.log(`Payment verified for ${serviceName}: ${verification.testnet ? 'TESTNET' : verification.txHash}`);
    req.paymentVerified = true;
    req.paymentTxHash = verification.txHash;
    
    next();
  };
}

// ============ SERVICE IMPLEMENTATIONS ============

// Brave Search API
async function braveSearch(query, count = 5) {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error('BRAVE_API_KEY not configured');
  }

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': apiKey
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`Brave Search failed: ${response.status}`);
  }

  const data = await response.json();
  return data.web?.results || [];
}

// Fetch and extract content with security checks
async function fetchAndExtract(urlString, selector = null) {
  // Security check
  const urlCheck = isUrlSafe(urlString);
  if (!urlCheck.safe) {
    throw new Error(urlCheck.reason);
  }
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15 second timeout
  
  try {
    const response = await fetch(urlString, {
      headers: {
        'User-Agent': 'NoxAgent/1.1 (https://nox-agent-service-production.up.railway.app; contact@masumi.network)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      signal: controller.signal,
      redirect: 'follow'
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    // Check content type
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw new Error('Only HTML/text content supported');
    }
    
    // Limit response size (5MB max)
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 5 * 1024 * 1024) {
      throw new Error('Content too large (max 5MB)');
    }

    const html = await response.text();
    
    // Double-check size after download
    if (html.length > 5 * 1024 * 1024) {
      throw new Error('Content too large');
    }
    
    const $ = cheerio.load(html);

    // Remove unwanted elements
    $('script, style, nav, footer, header, aside, iframe, noscript').remove();

    if (selector) {
      const element = $(selector);
      return {
        html: element.html()?.substring(0, 50000),
        text: element.text().trim().substring(0, 10000)
      };
    }

    const title = $('title').text().substring(0, 200);
    const description = $('meta[name="description"]').attr('content')?.substring(0, 500) || '';
    
    let content = '';
    const contentSelectors = ['article', 'main', '.content', '.post', '#content', '.article-body'];
    
    for (const sel of contentSelectors) {
      const el = $(sel);
      if (el.length && el.text().trim().length > 100) {
        content = el.text().trim();
        break;
      }
    }

    if (!content) {
      content = $('body').text().trim();
    }

    content = content.replace(/\s+/g, ' ').substring(0, 10000);

    return { title, description, content, url: urlString };
    
  } finally {
    clearTimeout(timeout);
  }
}

// ============ ROUTES ============

// Apply rate limiting to all routes
app.use(rateLimit);

// Health check (no rate limit needed but ok)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', agent: 'Nox-Agent', version: '1.2.0' });
});

// Root - API documentation
app.get('/', (req, res) => {
  res.json({
    name: 'Nox Agent Service',
    description: 'AI Agent offering paid services via x402 multi-chain payments',
    version: '1.2.0',
    security: {
      rateLimit: '10 requests/minute',
      urlValidation: 'Internal IPs blocked',
      paymentVerification: 'x402 facilitator verified'
    },
    wallets: {
      evm: WALLETS.evm,
      cardano: WALLETS.cardano
    },
    services: {
      'web-research': { quick: '$5', deep: '$10' },
      'hitl-verification': { simple: '$20', medium: '$35', complex: '$50' },
      'web-scraping': { single: '$3', multi: '$8' }
    },
    endpoints: {
      'GET /health': 'Health check (free)',
      'GET /availability': 'Service availability (free)',
      'POST /research': 'Web research (paid)',
      'POST /hitl': 'Human verification (paid)',
      'GET /hitl/:jobId': 'Check job status (free)',
      'POST /scrape': 'Web scraping (paid)'
    }
  });
});

app.get('/availability', (req, res) => {
  res.json({
    status: 'available',
    services: ['web-research', 'hitl-verification', 'web-scraping'],
    pricing: PRICING,
    limits: {
      rateLimit: '10/min',
      maxContentSize: '5MB',
      maxUrls: 5
    }
  });
});

// ============ PAID ENDPOINTS ============

// Web Research
app.post('/research', x402Middleware('web-research', 5), async (req, res) => {
  try {
    const { query, depth = 'quick', fetchContent = false } = req.body;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Valid query string required' });
    }
    
    if (query.length > 500) {
      return res.status(400).json({ error: 'Query too long (max 500 chars)' });
    }

    const count = depth === 'deep' ? 10 : 5;
    const searchResults = await braveSearch(query, count);

    const results = searchResults.map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
      age: r.age
    }));

    let extractedContent = [];
    if (depth === 'deep' && fetchContent) {
      for (const result of results.slice(0, 3)) {
        try {
          const extracted = await fetchAndExtract(result.url);
          extractedContent.push({
            url: result.url,
            title: extracted.title,
            content: extracted.content.substring(0, 2000)
          });
        } catch (err) {
          // Skip failed extractions silently
        }
      }
    }

    res.json({
      status: 'success',
      query,
      depth,
      resultCount: results.length,
      results,
      extractedContent: extractedContent.length > 0 ? extractedContent : undefined,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('Research error:', err.message);
    res.status(500).json({ 
      status: 'error', 
      error: 'Research service temporarily unavailable'
    });
  }
});

// HITL Verification
app.post('/hitl', x402Middleware('hitl-verification', 20), async (req, res) => {
  try {
    const { task, context, urgency = 'normal' } = req.body;

    if (!task || typeof task !== 'string') {
      return res.status(400).json({ error: 'Task description required' });
    }
    
    if (task.length > 5000) {
      return res.status(400).json({ error: 'Task too long (max 5000 chars)' });
    }

    const jobId = `hitl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const job = {
      jobId,
      task: task.substring(0, 5000),
      context: context?.substring(0, 2000),
      urgency,
      status: 'pending',
      createdAt: new Date().toISOString(),
      result: null
    };

    hitlJobs.set(jobId, job);

    res.json({
      status: 'pending',
      jobId,
      message: 'Request submitted for human review.',
      checkStatusAt: `/hitl/${jobId}`,
      estimatedTime: urgency === 'urgent' ? '1-4 hours' : '4-24 hours'
    });

  } catch (err) {
    console.error('HITL error:', err.message);
    res.status(500).json({ 
      status: 'error', 
      error: 'Service temporarily unavailable'
    });
  }
});

// Check HITL job status
app.get('/hitl/:jobId', (req, res) => {
  const job = hitlJobs.get(req.params.jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json(job);
});

// Admin: Complete HITL job
app.post('/hitl/:jobId/complete', async (req, res) => {
  const authKey = req.headers['x-admin-key'];
  if (authKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const job = hitlJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const { result, status = 'completed' } = req.body;

  job.status = status;
  job.result = result;
  job.completedAt = new Date().toISOString();

  res.json({ status: 'updated', job });
});

// Web Scraping
app.post('/scrape', x402Middleware('web-scraping', 3), async (req, res) => {
  try {
    const { url, urls, selector } = req.body;

    if (!url && !urls) {
      return res.status(400).json({ error: 'URL or URLs array required' });
    }

    const targetUrls = urls || [url];
    
    if (!Array.isArray(targetUrls) && typeof targetUrls !== 'string') {
      return res.status(400).json({ error: 'Invalid URL format' });
    }
    
    const urlList = Array.isArray(targetUrls) ? targetUrls : [targetUrls];
    
    if (urlList.length > 5) {
      return res.status(400).json({ error: 'Maximum 5 URLs per request' });
    }
    
    const results = [];

    for (const targetUrl of urlList) {
      try {
        const extracted = await fetchAndExtract(targetUrl, selector);
        results.push({
          url: targetUrl,
          status: 'success',
          data: extracted
        });
      } catch (err) {
        results.push({
          url: targetUrl,
          status: 'error',
          error: err.message
        });
      }
    }

    res.json({
      status: 'success',
      scraped: results.filter(r => r.status === 'success').length,
      failed: results.filter(r => r.status === 'error').length,
      results,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('Scrape error:', err.message);
    res.status(500).json({ 
      status: 'error', 
      error: 'Scraping service temporarily unavailable'
    });
  }
});

// Error handler - don't leak internal details
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║           NOX AGENT SERVICE v1.2.0             ║
╠════════════════════════════════════════════════╣
║  Security: Rate limiting, URL validation,      ║
║            Payment verification                ║
╠════════════════════════════════════════════════╣
║  Port: ${PORT}                                    ║
║  Testnet: ${process.env.TESTNET_MODE === 'true' ? 'ENABLED' : 'DISABLED'}                          ║
╚════════════════════════════════════════════════╝
  `);
});
