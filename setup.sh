#!/bin/bash

# ============================================================
# NewroHelp Main Server — Setup Script
# ============================================================

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo "=========================================="
echo " NewroHelp Main Server Setup"
echo "=========================================="

# ----------------------------------------
# 1. System dependencies (best-effort)
# ----------------------------------------
echo -e "${GREEN}[1/5] Checking system dependencies...${NC}"

# apt-get update can fail on EOL distros — don't let it abort the whole script
if apt-get update -q 2>/dev/null; then
    apt-get install -y curl git build-essential 2>/dev/null || true
else
    echo -e "${YELLOW}  apt-get update failed (possibly an EOL Ubuntu release).${NC}"
    echo -e "${YELLOW}  Continuing — curl/git/build-essential may already be present.${NC}"
fi

# ----------------------------------------
# 2. Node.js
# ----------------------------------------
echo -e "${GREEN}[2/5] Checking Node.js...${NC}"

NODE_OK=false
if command -v node &> /dev/null; then
    NODE_MAJOR=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])" 2>/dev/null)
    if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 18 ]; then
        echo -e "  ✓ Node.js $(node --version) already installed"
        NODE_OK=true
    else
        echo -e "${YELLOW}  Node.js $(node --version) found but version < 18. Attempting upgrade...${NC}"
    fi
fi

if [ "$NODE_OK" = false ]; then
    echo "  Installing Node.js 20 LTS via NodeSource..."
    if curl -fsSL https://deb.nodesource.com/setup_20.x | bash - ; then
        apt-get install -y nodejs
        echo -e "  ✓ Node.js $(node --version) installed"
    else
        echo -e "${RED}  NodeSource install failed. Trying nvm fallback...${NC}"
        export NVM_DIR="/root/.nvm"
        curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
        # shellcheck disable=SC1091
        [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
        nvm install 20
        nvm use 20
        nvm alias default 20
        echo -e "  ✓ Node.js $(node --version) installed via nvm"
        echo ""
        echo -e "${YELLOW}  NOTE: nvm was used. Add this to your shell profile (~/.bashrc):${NC}"
        echo '    export NVM_DIR="/root/.nvm"'
        echo '    [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"'
        echo ""
    fi
fi

if ! command -v node &> /dev/null; then
    echo -e "${RED}ERROR: Node.js installation failed. Install Node.js 20+ manually then re-run.${NC}"
    exit 1
fi

echo "  Node: $(node --version) | npm: $(npm --version)"

# ----------------------------------------
# 3. npm dependencies
# ----------------------------------------
echo -e "${GREEN}[3/5] Installing npm dependencies...${NC}"
npm install --omit=dev
echo "  ✓ Dependencies installed"

# ----------------------------------------
# 4. Environment file
# ----------------------------------------
echo -e "${GREEN}[4/5] Setting up environment...${NC}"
if [ ! -f ".env" ]; then
    cp env.example.txt .env
    echo -e "${YELLOW}
  .env created from template.
  IMPORTANT: Edit .env before starting the server.
  Required values:
    - OPENAI_API_KEY
    - GPU_SERVER_URL
    - GPU_SERVER_API_KEY
    - LARAVEL_API_URL
    - LARAVEL_API_SECRET
${NC}"
else
    echo "  .env already exists, skipping"
fi

# ----------------------------------------
# 5. Log directory
# ----------------------------------------
echo -e "${GREEN}[5/5] Creating log directory...${NC}"
mkdir -p logs
echo "  ✓ logs/ ready"

# ----------------------------------------
# Optional: systemd service
# ----------------------------------------
echo ""
read -p "Install as systemd service? (y/N): " INSTALL_SERVICE

if [[ "$INSTALL_SERVICE" =~ ^[Yy]$ ]]; then
    WORKING_DIR=$(pwd)
    NODE_BIN=$(which node)

    tee /etc/systemd/system/newrohelp-main-server.service > /dev/null <<EOF
[Unit]
Description=NewroHelp Main Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${WORKING_DIR}
ExecStart=${NODE_BIN} src/index.js
Restart=always
RestartSec=5
StandardOutput=append:${WORKING_DIR}/logs/combined.log
StandardError=append:${WORKING_DIR}/logs/error.log
EnvironmentFile=${WORKING_DIR}/.env

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable newrohelp-main-server

    echo -e "${GREEN}  ✓ Service installed as: newrohelp-main-server${NC}"
    echo ""
    echo "  Commands:"
    echo "    systemctl start newrohelp-main-server"
    echo "    systemctl status newrohelp-main-server"
    echo "    journalctl -u newrohelp-main-server -f"
fi

echo ""
echo "=========================================="
echo -e "${GREEN} Setup complete!${NC}"
echo "=========================================="
echo ""
echo "Next steps:"
echo "  1. Edit .env with your credentials"
echo "  2. node src/index.js"
echo "  3. curl http://localhost:3000/health"
echo ""