#!/bin/bash

# ============================================================
# NewroHelp Main Server — Setup Script
# Ubuntu 22.04 LTS
# ============================================================

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo "=========================================="
echo " NewroHelp Main Server Setup"
echo "=========================================="

# ----------------------------------------
# 1. System dependencies
# ----------------------------------------
echo -e "${GREEN}[1/5] Installing system dependencies...${NC}"
sudo apt-get update -q
sudo apt-get install -y curl git build-essential

# ----------------------------------------
# 2. Node.js 20 LTS
# ----------------------------------------
echo -e "${GREEN}[2/5] Installing Node.js 20 LTS...${NC}"
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "Node.js already installed: $(node --version)"
fi

echo "Node: $(node --version) | npm: $(npm --version)"

# ----------------------------------------
# 3. npm dependencies
# ----------------------------------------
echo -e "${GREEN}[3/5] Installing npm dependencies...${NC}"
npm install --production

# ----------------------------------------
# 4. Environment file
# ----------------------------------------
echo -e "${GREEN}[4/5] Setting up environment...${NC}"
if [ ! -f ".env" ]; then
    cp env.example.txt .env
    echo -e "${YELLOW}
  .env file created from template.
  IMPORTANT: Edit .env before starting the server.
  Required values:
    - TWILIO_ACCOUNT_SID
    - TWILIO_AUTH_TOKEN
    - OPENAI_API_KEY
    - GPU_SERVER_URL
    - GPU_SERVER_API_KEY
    - LARAVEL_API_URL
    - LARAVEL_API_SECRET
${NC}"
else
    echo ".env already exists, skipping"
fi

# ----------------------------------------
# 5. Log directory
# ----------------------------------------
echo -e "${GREEN}[5/5] Creating log directory...${NC}"
mkdir -p logs

# ----------------------------------------
# Optional: install as systemd service
# ----------------------------------------
echo ""
read -p "Install as systemd service? (y/N): " INSTALL_SERVICE

if [[ "$INSTALL_SERVICE" =~ ^[Yy]$ ]]; then
    SERVICE_USER=$(whoami)
    WORKING_DIR=$(pwd)
    NODE_BIN=$(which node)

    sudo tee /etc/systemd/system/newrohelp-main-server.service > /dev/null <<EOF
[Unit]
Description=NewroHelp Main Server
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${WORKING_DIR}
ExecStart=${NODE_BIN} src/index.js
Restart=always
RestartSec=5
StandardOutput=append:${WORKING_DIR}/logs/combined.log
StandardError=append:${WORKING_DIR}/logs/error.log

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable newrohelp-main-server

    echo -e "${GREEN}Service installed!${NC}"
    echo "Commands:"
    echo "  sudo systemctl start newrohelp-main-server"
    echo "  sudo systemctl status newrohelp-main-server"
    echo "  sudo journalctl -u newrohelp-main-server -f"
fi

echo ""
echo "=========================================="
echo -e "${GREEN} Setup complete!${NC}"
echo "=========================================="
echo ""
echo "Next steps:"
echo "  1. Edit .env with your credentials"
echo "  2. Run: npm start"
echo "  3. Test: curl http://localhost:3000/health"
echo ""