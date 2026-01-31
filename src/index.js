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
const startTime = Date.now();

// ============ SECURITY: Rate Limiting ============
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 10;

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

setInterval(() => {
  const now = Date.now();
  for (const [ip, limit] of rateLimits) {
    if (now - limit.windowStart > RATE_LIMIT_WINDOW * 2) {
      rateLimits.delete(ip);
    }
  }
}, 60000);

// ============ SECURITY: URL Validation ============
const BLOCKED_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1', 'metadata.google.internal', '169.254.169.254'];
const BLOCKED_IP_RANGES = [/^127\./, /^10\./, /^172\.(1[6-9]|2[0-9]|3[0-1])\./, /^192\.168\./, /^169\.254\./, /^fc00:/i, /^fe80:/i];

function isUrlSafe(urlString) {
  try {
    const url = new URL(urlString);
    if (!['http:', 'https:'].includes(url.protocol)) return { safe: false, reason: 'Only HTTP/HTTPS allowed' };
    const hostname = url.hostname.toLowerCase();
    if (BLOCKED_HOSTS.includes(hostname)) return { safe: false, reason: 'Blocked host' };
    for (const pattern of BLOCKED_IP_RANGES) {
      if (pattern.test(hostname)) return { safe: false, reason: 'Internal IP not allowed' };
    }
    if (hostname.endsWith('.internal') || hostname.endsWith('.local') || hostname.includes('metadata')) {
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
  'research': { amount: 5000000, description: 'Web Research' },
  'hitl': { amount: 20000000, description: 'Human-in-the-Loop Verification' },
  'scrape': { amount: 3000000, description: 'Web Scraping' }
};

// ============ JOB STORAGE ============
const jobs = new Map();

function createJob(serviceType, inputData) {
  const jobId = `job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const job = {
    job_id: jobId,
    service: serviceType,
    input: inputData,
    status: 'pending',
    result: null,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  jobs.set(jobId, job);
  return job;
}

function updateJob(jobId, updates) {
  const job = jobs.get(jobId);
  if (job) {
    Object.assign(job, updates, { updated_at: new Date().toISOString() });
  }
  return job;
}

// ============ SERVICE IMPLEMENTATIONS ============

async function braveSearch(query, count = 5) {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) throw new Error('BRAVE_API_KEY not configured');

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const response = await fetch(url, {
    headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) throw new Error(`Brave Search failed: ${response.status}`);
  const data = await response.json();
  return data.web?.results || [];
}

async function fetchAndExtract(urlString, selector = null) {
  const urlCheck = isUrlSafe(urlString);
  if (!urlCheck.safe) throw new Error(urlCheck.reason);
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  
  try {
    const response = await fetch(urlString, {
      headers: {
        'User-Agent': 'NoxAgent/1.3 (Masumi Network Agent)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      signal: controller.signal,
      redirect: 'follow'
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw new Error('Only HTML/text content supported');
    }

    const html = await response.text();
    if (html.length > 5 * 1024 * 1024) throw new Error('Content too large');
    
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header, aside, iframe, noscript').remove();

    if (selector) {
      const element = $(selector);
      return { html: element.html()?.substring(0, 50000), text: element.text().trim().substring(0, 10000) };
    }

    const title = $('title').text().substring(0, 200);
    const description = $('meta[name="description"]').attr('content')?.substring(0, 500) || '';
    
    let content = '';
    for (const sel of ['article', 'main', '.content', '.post', '#content']) {
      const el = $(sel);
      if (el.length && el.text().trim().length > 100) {
        content = el.text().trim();
        break;
      }
    }
    if (!content) content = $('body').text().trim();
    content = content.replace(/\s+/g, ' ').substring(0, 10000);

    return { title, description, content, url: urlString };
  } finally {
    clearTimeout(timeout);
  }
}

async function executeResearch(inputData) {
  const queryInput = inputData.find(i => i.key === 'query');
  const depthInput = inputData.find(i => i.key === 'depth');
  
  if (!queryInput?.value) throw new Error('Query is required');
  
  const query = queryInput.value;
  const depth = depthInput?.value || 'quick';
  const count = depth === 'deep' ? 10 : 5;
  
  const searchResults = await braveSearch(query, count);
  const results = searchResults.map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.description
  }));

  return {
    query,
    depth,
    result_count: results.length,
    results,
    timestamp: new Date().toISOString()
  };
}

async function executeScrape(inputData) {
  const urlInput = inputData.find(i => i.key === 'url');
  const selectorInput = inputData.find(i => i.key === 'selector');
  
  if (!urlInput?.value) throw new Error('URL is required');
  
  const extracted = await fetchAndExtract(urlInput.value, selectorInput?.value);
  return {
    url: urlInput.value,
    data: extracted,
    timestamp: new Date().toISOString()
  };
}

async function executeHitl(inputData) {
  const taskInput = inputData.find(i => i.key === 'task');
  
  if (!taskInput?.value) throw new Error('Task description is required');
  
  // HITL jobs remain pending until manually completed
  return {
    message: 'Task submitted for human review',
    task: taskInput.value.substring(0, 500),
    estimated_time: '4-24 hours'
  };
}

// ============ MIP-003 COMPLIANT ENDPOINTS ============

app.use(rateLimit);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// MIP-003: Availability
app.get('/availability', (req, res) => {
  res.json({
    status: 'available',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    message: 'Nox Agent Service operational. Services: research, scrape, hitl.'
  });
});

// MIP-003: Input Schema
app.get('/input_schema', (req, res) => {
  res.json({
    input_data: [
      {
        id: 'service',
        type: 'string',
        name: 'Service Type',
        data: {
          description: 'The service to execute: research, scrape, or hitl',
          placeholder: 'research'
        }
      },
      {
        id: 'query',
        type: 'string',
        name: 'Search Query',
        data: {
          description: 'For research service: the search query',
          placeholder: 'AI agent payments'
        }
      },
      {
        id: 'url',
        type: 'string',
        name: 'URL to Scrape',
        data: {
          description: 'For scrape service: the URL to extract content from',
          placeholder: 'https://example.com/article'
        }
      },
      {
        id: 'task',
        type: 'string',
        name: 'HITL Task',
        data: {
          description: 'For hitl service: the task requiring human verification',
          placeholder: 'Verify this contract is legitimate'
        }
      },
      {
        id: 'depth',
        type: 'string',
        name: 'Research Depth',
        data: {
          description: 'Optional: quick (5 results) or deep (10 results)',
          placeholder: 'quick'
        }
      },
      {
        id: 'selector',
        type: 'string',
        name: 'CSS Selector',
        data: {
          description: 'Optional: CSS selector to extract specific content',
          placeholder: 'article.main-content'
        }
      }
    ]
  });
});

// MIP-003: Start Job
app.post('/start_job', async (req, res) => {
  try {
    const { input_data } = req.body;
    
    if (!input_data || !Array.isArray(input_data)) {
      return res.status(400).json({ 
        error: 'Bad Request',
        message: 'input_data array is required' 
      });
    }

    // Determine service type
    const serviceInput = input_data.find(i => i.key === 'service');
    const serviceType = serviceInput?.value || 'research';
    
    if (!['research', 'scrape', 'hitl'].includes(serviceType)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid service type. Must be: research, scrape, or hitl'
      });
    }

    // Create the job
    const job = createJob(serviceType, input_data);
    
    // For demo/testing: execute immediately if no payment required
    // In production, this would wait for payment confirmation
    if (process.env.TESTNET_MODE === 'true' || process.env.DEMO_MODE === 'true') {
      // Execute the job
      try {
        job.status = 'running';
        let result;
        
        switch (serviceType) {
          case 'research':
            result = await executeResearch(input_data);
            break;
          case 'scrape':
            result = await executeScrape(input_data);
            break;
          case 'hitl':
            result = await executeHitl(input_data);
            break;
        }
        
        updateJob(job.job_id, { status: 'completed', result });
      } catch (execError) {
        updateJob(job.job_id, { status: 'failed', error: execError.message });
      }
    }

    res.json({
      job_id: job.job_id,
      payment_id: `pay-${job.job_id}`,
      status: job.status,
      service: serviceType,
      price: PRICING[serviceType]
    });

  } catch (err) {
    console.error('start_job error:', err.message);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

// MIP-003: Job Status
app.get('/status', (req, res) => {
  const { job_id } = req.query;
  
  if (!job_id) {
    return res.status(400).json({ error: 'Bad Request', message: 'job_id query parameter required' });
  }
  
  const job = jobs.get(job_id);
  
  if (!job) {
    return res.status(404).json({ error: 'Not Found', message: 'Job not found' });
  }
  
  res.json({
    job_id: job.job_id,
    status: job.status,
    result: job.result,
    error: job.error
  });
});

// ============ LEGACY ENDPOINTS (for backwards compatibility) ============

// Root - API documentation
app.get('/', (req, res) => {
  res.json({
    name: 'Nox Agent Service',
    version: '1.3.0',
    description: 'AI Agent offering paid services via Masumi Network',
    masumi: {
      compliant: true,
      standard: 'MIP-003',
      agentId: 'cml1fwd6l000c5cmhr2b6ooi5'
    },
    wallets: WALLETS,
    services: {
      research: { price: '5 ADA', description: 'Web research and summarization' },
      scrape: { price: '3 ADA', description: 'Web page content extraction' },
      hitl: { price: '20 ADA', description: 'Human-in-the-loop verification' }
    },
    endpoints: {
      'GET /health': 'Health check',
      'GET /availability': 'Service availability (MIP-003)',
      'GET /input_schema': 'Input schema (MIP-003)',
      'POST /start_job': 'Start a job (MIP-003)',
      'GET /status?job_id=': 'Job status (MIP-003)'
    }
  });
});

// Legacy direct endpoints (optional, for x402 compatibility)
app.post('/research', async (req, res) => {
  const { query, depth } = req.body;
  const input_data = [
    { key: 'service', value: 'research' },
    { key: 'query', value: query },
    { key: 'depth', value: depth || 'quick' }
  ];
  
  try {
    const result = await executeResearch(input_data);
    res.json({ status: 'success', ...result });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.post('/scrape', async (req, res) => {
  const { url, selector } = req.body;
  const input_data = [
    { key: 'service', value: 'scrape' },
    { key: 'url', value: url },
    { key: 'selector', value: selector }
  ];
  
  try {
    const result = await executeScrape(input_data);
    res.json({ status: 'success', ...result });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║         NOX AGENT SERVICE v1.3.0 (MIP-003)         ║
╠════════════════════════════════════════════════════╣
║  Masumi Network Compatible                         ║
║  Endpoints: /start_job, /status, /input_schema     ║
╠════════════════════════════════════════════════════╣
║  Port: ${PORT}                                        ║
║  Demo Mode: ${process.env.DEMO_MODE === 'true' ? 'ENABLED' : 'DISABLED'}                            ║
╚════════════════════════════════════════════════════╝
  `);
});
