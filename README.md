# Polygon Flash-Loan Liquidation Bot

This project runs Aave V3 liquidations on Polygon. The active flow is:

1. The off-chain bot finds unhealthy Aave borrowers.
2. `LiquidationBot` takes an Aave V3 flash loan in the debt token.
3. The contract repays the borrower's debt through Aave liquidation.
4. Aave sends collateral to the contract.
5. The contract swaps collateral back into the debt token through QuickSwap or SushiSwap.
6. The contract repays the flash loan and sends remaining profit to the owner wallet.

This is not a triangular arbitrage bot.

## Active Files

- `contracts/LiquidationBot.sol` - main Polygon liquidation contract.
- `bot/liquidation-bot.js` - off-chain borrower scanner and executor.
- `scripts/deploy-liquidation.js` - deployment script for the liquidation contract.
- `test/LiquidationBot.test.js` - flash loan, liquidation, swap, repay, and profit tests.

## Setup

Install dependencies:

```bash
npm install
npm --prefix bot install
```

Create `.env` in the repo root:

```env
POLYGON_RPC_URL=https://polygon-rpc.com/
PRIVATE_KEY=your_wallet_private_key
ETHERSCAN_API_KEY=your_etherscan_v2_api_key_optional
```

Create `bot/.env`:

```env
POLYGON_RPC_URL=https://polygon-rpc.com/
PRIVATE_KEY=your_wallet_private_key
LIQUIDATION_BOT_ADDRESS=your_deployed_liquidation_bot_address
GRAPH_API_KEY=your_graph_api_key
```

The bot wallet must be the same wallet that deployed `LiquidationBot`, because only the owner can execute liquidations.

Optional bot speed controls for `bot/.env`:

```env
BORROWER_FETCH_LIMIT=500
SCAN_INTERVAL_SECONDS=30
UNPROFITABLE_COOLDOWN_SECONDS=900
DEBT_TOKENS=USDCe,USDC,USDT,DAI
COLLATERAL_TOKENS=WBTC,WETH,WMATIC,AAVE,LINK,DAI,USDCe,USDC,USDT
```

## Deploy

Polygon mainnet:

```bash
npm run deploy:polygon
```

Amoy testnet:

```bash
npm run deploy:amoy
```

After deployment, copy the printed contract address into `bot/.env` as `LIQUIDATION_BOT_ADDRESS`.

## Run

```bash
npm run bot:liquidation
```

## Verify

```bash
npx hardhat verify --network polygon <LIQUIDATION_BOT_ADDRESS>
```

## Checks

```bash
npx hardhat compile
npx hardhat test
node --check bot/liquidation-bot.js
npm audit --omit=dev
npm --prefix bot audit --omit=dev
```

## Mainnet Safety

- Use a fresh wallet that you control.
- Keep `PRIVATE_KEY` out of GitHub.
- Deploy a new `LiquidationBot` from the same wallet that will run the bot.
- Start with small liquidations and watch gas, slippage, and failed transaction rate.
- Do not use old contract addresses with a new wallet.
