import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Wallet addresses for receiving payments
const WALLETS = {
  evm: process.env.EVM_WALLET || '0x0000000000000000000000000000000000000000',
  cardano: process.env.CARDANO_WALLET || 'addr_test1qr02ugx4tngn8uc5e5v8mtu2fpfprms4u6uzy0vvtgknudzkrj73vaz964ac2s5qm8rs7l05hq0vngcx0gpsxj0rzxzs7paafj'
};

// Service pricing (in USD)
const PRICING = {
  webResearch: {
    quick: 5,      // $5 - quick web search
    deep: 10       // $10 - comprehensive research
  },
  hitl: {
    simple: 20,    // $20 - simple approval
    medium: 35,    // $35 - requires analysis
    complex: 50    // $50+ - complex judgment
  },
  webScrape: {
    single: 3,     // $3 - single page
    multi: 8       // $8 - multi-page crawl
  }
};

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', agent: 'Nox', version: '1.0.0' });
});

// Service availability
app.get('/availability', (req, res) => {
  res.json({
    status: 'available',
    services: ['web-research', 'hitl-verification', 'web-scraping'],
    pricing: PRICING,
    paymentMethods: ['x402-evm', 'x402-cardano', 'masumi']
  });
});

// Input schema for Masumi compatibility
app.get('/input_schema', (req, res) => {
  res.json({
    type: 'object',
    properties: {
      service: {
        type: 'string',
        enum: ['web-research', 'hitl-verification', 'web-scraping'],
        description: 'Service type to request'
      },
      tier: {
        type: 'string',
        enum: ['quick', 'deep', 'simple', 'medium', 'complex', 'single', 'multi'],
        description: 'Service tier (affects pricing)'
      },
      input: {
        type: 'string',
        description: 'The query, URL, or task description'
      },
      context: {
        type: 'string',
        description: 'Additional context for the request'
      }
    },
    required: ['service', 'tier', 'input']
  });
});

// Quote endpoint - returns pricing before payment
app.post('/quote', (req, res) => {
  const { service, tier, input } = req.body;
  
  let price = 0;
  let estimatedTime = '';
  
  switch(service) {
    case 'web-research':
      price = tier === 'deep' ? PRICING.webResearch.deep : PRICING.webResearch.quick;
      estimatedTime = tier === 'deep' ? '5-10 minutes' : '1-2 minutes';
      break;
    case 'hitl-verification':
      price = PRICING.hitl[tier] || PRICING.hitl.simple;
      estimatedTime = '1-24 hours (depends on human availability)';
      break;
    case 'web-scraping':
      price = tier === 'multi' ? PRICING.webScrape.multi : PRICING.webScrape.single;
      estimatedTime = tier === 'multi' ? '3-5 minutes' : '30 seconds';
      break;
    default:
      return res.status(400).json({ error: 'Unknown service type' });
  }
  
  res.json({
    service,
    tier,
    price_usd: price,
    estimated_time: estimatedTime,
    payment_options: [
      {
        method: 'x402-evm',
        networks: ['eip155:8453', 'eip155:1', 'eip155:137'],
        token: 'USDC',
        amount: price,
        payTo: WALLETS.evm
      },
      {
        method: 'x402-cardano',
        network: 'cardano-preprod',
        token: 'ADA',
        amount: Math.ceil(price * 3), // ~$0.35/ADA
        payTo: WALLETS.cardano
      },
      {
        method: 'masumi',
        endpoint: process.env.MASUMI_PAYMENT_URL
      }
    ]
  });
});

// Start job endpoint (Masumi compatible)
app.post('/start_job', async (req, res) => {
  const { input_data } = req.body;
  
  // Parse Masumi-style input
  const data = {};
  if (Array.isArray(input_data)) {
    input_data.forEach(item => {
      data[item.key] = item.value;
    });
  }
  
  const jobId = `nox-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  // For now, return job created - actual execution would happen async
  res.json({
    job_id: jobId,
    status: 'created',
    message: 'Job created. Payment required to proceed.',
    quote_url: `/quote`,
    service: data.service || 'web-research',
    input: data.input
  });
});

// Job status
app.get('/status', (req, res) => {
  const { job_id } = req.query;
  
  // Placeholder - would check actual job status
  res.json({
    job_id,
    status: 'pending_payment',
    message: 'Awaiting payment confirmation'
  });
});

// API documentation
app.get('/', (req, res) => {
  res.json({
    name: 'Nox Agent Service',
    description: 'AI Agent offering Web Research, HITL Verification, and Web Scraping',
    version: '1.0.0',
    author: 'Jami / Masumi Network',
    endpoints: {
      '/health': 'Health check',
      '/availability': 'Service availability and pricing',
      '/input_schema': 'Input schema for requests',
      '/quote': 'Get pricing quote before payment',
      '/start_job': 'Start a new job (Masumi compatible)',
      '/status': 'Check job status'
    },
    payment_methods: [
      'x402 (EVM: Base, Ethereum, Polygon)',
      'x402 (Cardano)',
      'Masumi Payment Service'
    ]
  });
});

app.listen(PORT, () => {
  console.log(`Nox Agent Service running on port ${PORT}`);
  console.log(`Services: Web Research, HITL, Web Scraping`);
  console.log(`Payment: x402 multi-chain + Masumi`);
});
