#!/bin/bash
# =============================================
# AI Trading Platform - Setup Script
# =============================================

set -e

echo ""
echo "⚡ AI TRADING AUTOMATION PLATFORM - SETUP"
echo "============================================"
echo ""

# Check Node.js version
NODE_VERSION=$(node -v 2>/dev/null | cut -d'v' -f2 | cut -d'.' -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 18 ]; then
  echo "❌ Node.js 18+ required. Current: $(node -v 2>/dev/null || echo 'not found')"
  exit 1
fi
echo "✅ Node.js $(node -v)"

# Copy env if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✅ Created .env from .env.example"
  echo "⚠️  Edit .env with your API keys before starting!"
else
  echo "✅ .env already exists"
fi

# Install backend deps
echo ""
echo "📦 Installing backend dependencies..."
npm install
echo "✅ Backend dependencies installed"

# Install dashboard deps
echo ""
echo "📦 Installing dashboard dependencies..."
cd dashboard && npm install && cd ..
echo "✅ Dashboard dependencies installed"

# Build backend
echo ""
echo "🔨 Building backend TypeScript..."
npm run build
echo "✅ Backend built"

echo ""
echo "============================================"
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Edit .env with your Binance API keys"
echo "  2. Start PostgreSQL & Redis (or use Docker)"
echo "  3. Run: npm run dev      (backend)"
echo "  4. Run: cd dashboard && npm run dev  (frontend)"
echo ""
echo "OR with Docker:"
echo "  docker-compose up -d"
echo ""
echo "Dashboard: http://localhost:3000"
echo "API:       http://localhost:3001"
echo "Health:    http://localhost:3001/health"
echo "============================================"
