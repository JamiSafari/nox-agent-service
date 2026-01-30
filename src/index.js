import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import * as cheerio from 'cheerio';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Wallet addresses
const WALLETS = {
  evm: process.env.EVM_WALLET || '0x884428a7e667A8AC04EF904Ad8ec75E55bbC9Ad7',
  cardano: process.env.CARDANO_WALLET || 'addr_test1qr02ugx4tngn8uc5e5v8mtu2fpfprms4u6uzy0vvtgknudzkrj73vaz964ac2s5qm8rs7l05hq0vngcx0gpsxj0rzxzs7paafj'
};

// Service pricing (USD)
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

// x402 Payment Requirements generator
function getPaymentRequirements(service, amount) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453', // Base
        maxAmountRequired: String(amount * 1000000), // USDC has 6 decimals
        resource: `https://nox-agent-service-production.up.railway.app/${service}`,
        description: `Nox Agent - ${service}`,
        mimeType: 'application/json',
        payTo: WALLETS.evm,
        maxTimeoutSeconds: 300,
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' // USDC on Base
      },
      {
        scheme: 'exact',
        network: 'eip155:84532', // Base Sepolia (testnet)
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

// x402 middleware - checks for payment header
function x402Middleware(serviceName, priceUSD) {
  return async (req, res, next) => {
    const paymentHeader = req.headers['x-payment'];
    
    if (!paymentHeader) {
      // Return 402 with payment requirements
      res.status(402).json({
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
      return;
    }

    // TODO: Verify payment with facilitator
    // For now, we'll accept any payment header as valid (testnet behavior)
    console.log('Payment header received:', paymentHeader.substring(0, 50) + '...');
    next();
  };
}

// ============ ACTUAL SERVICE IMPLEMENTATIONS ============

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
    }
  });

  if (!response.ok) {
    throw new Error(`Brave Search failed: ${response.status}`);
  }

  const data = await response.json();
  return data.web?.results || [];
}

// Fetch and extract content from a URL
async function fetchAndExtract(url, selector = null) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; NoxAgent/1.0; +https://nox-agent-service-production.up.railway.app)'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  // Remove script and style elements
  $('script, style, nav, footer, header, aside').remove();

  if (selector) {
    // Extract specific element
    const element = $(selector);
    return {
      html: element.html(),
      text: element.text().trim().substring(0, 5000)
    };
  }

  // Extract main content
  const title = $('title').text();
  const description = $('meta[name="description"]').attr('content') || '';
  
  // Try common content selectors
  let content = '';
  const contentSelectors = ['article', 'main', '.content', '.post', '#content', '.article-body'];
  
  for (const sel of contentSelectors) {
    const el = $(sel);
    if (el.length && el.text().trim().length > 100) {
      content = el.text().trim();
      break;
    }
  }

  // Fallback to body
  if (!content) {
    content = $('body').text().trim();
  }

  // Clean up whitespace
  content = content.replace(/\s+/g, ' ').substring(0, 5000);

  return { title, description, content, url };
}

// Notify Nox (Clawdbot) about HITL request
async function notifyNox(jobId, task, context, urgency) {
  const webhookUrl = process.env.CLAWDBOT_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('No CLAWDBOT_WEBHOOK_URL configured, skipping notification');
    return;
  }

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'hitl_request',
        jobId,
        task,
        context,
        urgency,
        timestamp: new Date().toISOString()
      })
    });
  } catch (err) {
    console.error('Failed to notify Nox:', err.message);
  }
}

// ============ ROUTES ============

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', agent: 'Nox-Agent', version: '1.1.0' });
});

// Root - API documentation
app.get('/', (req, res) => {
  res.json({
    name: 'Nox Agent Service',
    description: 'AI Agent offering paid services via x402 multi-chain payments',
    version: '1.1.0',
    wallets: {
      evm: WALLETS.evm,
      cardano: WALLETS.cardano
    },
    services: {
      'web-research': { quick: '$5', deep: '$10', description: 'Search the web and summarize findings' },
      'hitl-verification': { simple: '$20', medium: '$35', complex: '$50', description: 'Human verification of tasks' },
      'web-scraping': { single: '$3', multi: '$8', description: 'Extract content from web pages' }
    },
    endpoints: {
      'GET /health': 'Health check (free)',
      'GET /availability': 'Service availability (free)',
      'POST /research': 'Web research (paid - $5-10)',
      'POST /hitl': 'Human verification (paid - $20-50)',
      'GET /hitl/:jobId': 'Check HITL job status (free)',
      'POST /scrape': 'Web scraping (paid - $3-8)'
    },
    payment: {
      methods: ['x402 (USDC on Base/Ethereum)', 'Masumi (ADA)', 'Direct Cardano']
    }
  });
});

// Free endpoints
app.get('/availability', (req, res) => {
  res.json({
    status: 'available',
    services: ['web-research', 'hitl-verification', 'web-scraping'],
    pricing: PRICING
  });
});

// ============ PAID ENDPOINTS ============

// Web Research - REAL IMPLEMENTATION
app.post('/research', x402Middleware('web-research', 5), async (req, res) => {
  try {
    const { query, depth = 'quick', fetchContent = false } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Search with Brave
    const count = depth === 'deep' ? 10 : 5;
    const searchResults = await braveSearch(query, count);

    // Format results
    const results = searchResults.map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
      age: r.age
    }));

    // For deep research, also fetch and extract content from top results
    let extractedContent = [];
    if (depth === 'deep' && fetchContent) {
      const topUrls = results.slice(0, 3);
      for (const result of topUrls) {
        try {
          const extracted = await fetchAndExtract(result.url);
          extractedContent.push({
            url: result.url,
            title: extracted.title,
            content: extracted.content.substring(0, 2000)
          });
        } catch (err) {
          console.error(`Failed to extract ${result.url}:`, err.message);
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
    console.error('Research error:', err);
    res.status(500).json({ 
      status: 'error', 
      error: err.message 
    });
  }
});

// HITL Verification - Queue and notify
app.post('/hitl', x402Middleware('hitl-verification', 20), async (req, res) => {
  try {
    const { task, context, urgency = 'normal' } = req.body;

    if (!task) {
      return res.status(400).json({ error: 'Task description is required' });
    }

    const jobId = `hitl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const job = {
      jobId,
      task,
      context,
      urgency,
      status: 'pending',
      createdAt: new Date().toISOString(),
      result: null
    };

    hitlJobs.set(jobId, job);

    // Notify Nox about the new request
    await notifyNox(jobId, task, context, urgency);

    res.json({
      status: 'pending',
      jobId,
      task,
      message: 'Request submitted for human review.',
      checkStatusAt: `/hitl/${jobId}`,
      estimatedTime: urgency === 'urgent' ? '1-4 hours' : '4-24 hours'
    });

  } catch (err) {
    console.error('HITL error:', err);
    res.status(500).json({ 
      status: 'error', 
      error: err.message 
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

// Update HITL job (internal endpoint for Nox to complete jobs)
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

// Web Scraping - REAL IMPLEMENTATION
app.post('/scrape', x402Middleware('web-scraping', 3), async (req, res) => {
  try {
    const { url, urls, selector } = req.body;

    if (!url && !urls) {
      return res.status(400).json({ error: 'URL or URLs array is required' });
    }

    const targetUrls = urls || [url];
    const results = [];

    for (const targetUrl of targetUrls.slice(0, 5)) { // Max 5 URLs
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
      scraped: results.length,
      results,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('Scrape error:', err);
    res.status(500).json({ 
      status: 'error', 
      error: err.message 
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║           NOX AGENT SERVICE v1.1.0             ║
╠════════════════════════════════════════════════╣
║  Port: ${PORT}                                    ║
║  EVM:  ${WALLETS.evm.substring(0,20)}...      ║
║  ADA:  ${WALLETS.cardano.substring(0,20)}...  ║
╠════════════════════════════════════════════════╣
║  Services: Research | HITL | Scraping          ║
║  Status: FULLY OPERATIONAL                     ║
╚════════════════════════════════════════════════╝
  `);
});
