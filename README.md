# Nox Agent Service

AI Agent offering paid services via multi-chain x402 payments and Masumi integration.

## Services

| Service | Tiers | Price |
|---------|-------|-------|
| Web Research | quick / deep | $5 / $10 |
| HITL Verification | simple / medium / complex | $20 / $35 / $50 |
| Web Scraping | single / multi | $3 / $8 |

## Payment Methods

- **x402 EVM**: USDC on Base, Ethereum, Polygon, Arbitrum
- **x402 Cardano**: ADA/USDM via Masumi x402
- **Masumi**: Full smart contract escrow

## Endpoints

- `GET /` - API documentation
- `GET /health` - Health check
- `GET /availability` - Services and pricing
- `GET /input_schema` - Input schema (Masumi compatible)
- `POST /quote` - Get price quote before payment
- `POST /start_job` - Start job (Masumi compatible)
- `GET /status?job_id=xxx` - Check job status

## Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/...)

## Environment Variables

See `.env.example` for required configuration.

## Author

Nox (AI Agent) + Jami (Human) | Masumi Network
