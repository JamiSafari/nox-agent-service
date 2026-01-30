import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

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

// x402 Payment Requirements generator
function getPaymentRequirements(service, amount) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453', // Base
        maxAmountRequired: String(amount * 1000000), // USDC has 6 decimals
        resource: `https://nox-agent.masumi.network/${service}`,
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
        resource: `https://nox-agent.masumi.network/${service}`,
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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', agent: 'Nox-Agent', version: '1.0.0' });
});

// Root - API documentation
app.get('/', (req, res) => {
  res.json({
    name: 'Nox Agent Service',
    description: 'AI Agent offering paid services via x402 multi-chain payments',
    version: '1.0.0',
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
      'POST /research': 'Web research (paid - $5-10)',
      'POST /hitl': 'Human verification (paid - $20-50)',
      'POST /scrape': 'Web scraping (paid - $3-8)'
    },
    payment: {
      methods: ['x402 (USDC on Base/Ethereum)', 'Masumi (ADA)', 'Direct Cardano'],
      facilitator: process.env.X402_FACILITATOR_URL
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

// Paid endpoints with x402

// Web Research
app.post('/research', x402Middleware('web-research', 5), async (req, res) => {
  const { query, depth = 'quick' } = req.body;
  
  // TODO: Implement actual research logic
  res.json({
    status: 'success',
    query,
    depth,
    results: [
      { title: 'Research Result 1', url: 'https://example.com/1', snippet: 'Sample result...' }
    ],
    note: 'Real implementation coming soon - will use web_search + web_fetch'
  });
});

// HITL Verification
app.post('/hitl', x402Middleware('hitl-verification', 20), async (req, res) => {
  const { task, context, urgency = 'normal' } = req.body;
  
  // TODO: Implement notification to Jami and response flow
  res.json({
    status: 'pending',
    jobId: `hitl-${Date.now()}`,
    task,
    message: 'Request submitted for human review. Check back for status.',
    estimatedTime: urgency === 'urgent' ? '1-4 hours' : '4-24 hours'
  });
});

// Web Scraping
app.post('/scrape', x402Middleware('web-scraping', 3), async (req, res) => {
  const { url, selector, waitFor } = req.body;
  
  // TODO: Implement browser automation
  res.json({
    status: 'success',
    url,
    note: 'Real implementation coming soon - will use browser control',
    data: { placeholder: 'Scraped content would appear here' }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║           NOX AGENT SERVICE v1.0.0             ║
╠════════════════════════════════════════════════╣
║  Port: ${PORT}                                    ║
║  EVM:  ${WALLETS.evm.substring(0,20)}...      ║
║  ADA:  ${WALLETS.cardano.substring(0,20)}...  ║
╠════════════════════════════════════════════════╣
║  Services: Research | HITL | Scraping          ║
║  Payments: x402 (USDC) | Masumi (ADA)          ║
╚════════════════════════════════════════════════╝
  `);
});
