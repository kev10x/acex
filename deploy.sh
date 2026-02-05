#!/bin/bash

###############################################################################
# MarkMate Deployment Script for Virtualmin
# 
# This script deploys MarkMate from GitHub to a Virtualmin-managed server
# 
# Usage:
#   ./deploy.sh [options]
#
# Options:
#   --domain=example.com     Domain name (required)
#   --branch=main            Git branch to deploy (default: main)
#   --env-file=.env.prod     Path to production .env file (optional)
#   --skip-build             Skip frontend build (for faster redeployments)
#   --skip-deps              Skip npm install (for faster redeployments)
#
# Prerequisites:
#   - Node.js and npm installed
#   - Git installed
#   - PM2 installed globally (npm install -g pm2) for process management
#   - Virtualmin domain configured
###############################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Default values
BRANCH="main"
SKIP_BUILD=false
SKIP_DEPS=false
ENV_FILE=""
DOMAIN=""

# Parse command line arguments
for arg in "$@"; do
  case $arg in
    --domain=*)
      DOMAIN="${arg#*=}"
      shift
      ;;
    --branch=*)
      BRANCH="${arg#*=}"
      shift
      ;;
    --env-file=*)
      ENV_FILE="${arg#*=}"
      shift
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --skip-deps)
      SKIP_DEPS=true
      shift
      ;;
    *)
      echo -e "${RED}Unknown option: $arg${NC}"
      exit 1
      ;;
  esac
done

# Check if domain is provided
if [ -z "$DOMAIN" ]; then
  echo -e "${RED}Error: Domain is required${NC}"
  echo "Usage: ./deploy.sh --domain=example.com [options]"
  exit 1
fi

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}MarkMate Deployment Script${NC}"
echo -e "${GREEN}========================================${NC}"
echo "Domain: $DOMAIN"
echo "Branch: $BRANCH"
echo ""

# Get the script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
DEPLOY_DIR="$SCRIPT_DIR"

# If running from a different location, use current directory
if [ ! -f "$DEPLOY_DIR/package.json" ]; then
  DEPLOY_DIR="$(pwd)"
fi

echo -e "${YELLOW}Deployment directory: $DEPLOY_DIR${NC}"
cd "$DEPLOY_DIR"

# Step 1: Check prerequisites
echo -e "\n${YELLOW}[1/8] Checking prerequisites...${NC}"

# Check Node.js
if ! command -v node &> /dev/null; then
  echo -e "${RED}Error: Node.js is not installed${NC}"
  exit 1
fi
NODE_VERSION=$(node -v)
echo "✓ Node.js: $NODE_VERSION"

# Check npm
if ! command -v npm &> /dev/null; then
  echo -e "${RED}Error: npm is not installed${NC}"
  exit 1
fi
NPM_VERSION=$(npm -v)
echo "✓ npm: $NPM_VERSION"

# Check Git
if ! command -v git &> /dev/null; then
  echo -e "${RED}Error: Git is not installed${NC}"
  exit 1
fi
GIT_VERSION=$(git --version)
echo "✓ $GIT_VERSION"

# Check PM2 (optional but recommended)
if command -v pm2 &> /dev/null; then
  PM2_VERSION=$(pm2 -v)
  echo "✓ PM2: $PM2_VERSION"
  USE_PM2=true
else
  echo -e "${YELLOW}⚠ PM2 not found. Install with: npm install -g pm2${NC}"
  echo -e "${YELLOW}  The app will run without PM2 process management${NC}"
  USE_PM2=false
fi

# Step 2: Pull latest code from GitHub
echo -e "\n${YELLOW}[2/8] Pulling latest code from GitHub...${NC}"
if [ -d ".git" ]; then
  echo "Fetching latest changes..."
  git fetch origin
  echo "Checking out branch: $BRANCH"
  git checkout "$BRANCH"
  git pull origin "$BRANCH"
  echo -e "${GREEN}✓ Code updated${NC}"
else
  echo -e "${RED}Error: Not a git repository${NC}"
  echo "Please clone the repository first:"
  echo "  git clone https://github.com/kev10x/markmateio.git"
  exit 1
fi

# Step 3: Install/update dependencies
if [ "$SKIP_DEPS" = false ]; then
  echo -e "\n${YELLOW}[3/8] Installing dependencies...${NC}"
  echo "Installing server dependencies..."
  npm install
  echo "Installing client dependencies..."
  cd client
  npm install
  cd ..
  echo -e "${GREEN}✓ Dependencies installed${NC}"
else
  echo -e "\n${YELLOW}[3/8] Skipping dependency installation${NC}"
fi

# Step 4: Set up environment variables
echo -e "\n${YELLOW}[4/8] Setting up environment variables...${NC}"
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  echo "Copying environment file from $ENV_FILE..."
  cp "$ENV_FILE" .env
  echo -e "${GREEN}✓ Environment file copied${NC}"
elif [ ! -f ".env" ]; then
  echo -e "${YELLOW}⚠ .env file not found. Creating from template...${NC}"
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo -e "${YELLOW}⚠ Please edit .env file with your configuration${NC}"
  else
    echo -e "${YELLOW}⚠ Creating basic .env file...${NC}"
    cat > .env << EOF
# Database
DATABASE_URL=sqlite:./database.sqlite

# Server
PORT=3001
NODE_ENV=production

# JWT Secret (CHANGE THIS!)
JWT_SECRET=$(openssl rand -base64 32)
JWT_EXPIRES_IN=24h

# API Keys (Add your keys here)
OPENAI_API_KEY=
ANTHROPIC_API_KEY=

# Client URL (with /tools path)
CLIENT_URL=https://$DOMAIN/tools
EOF
    echo -e "${YELLOW}⚠ Please edit .env file with your API keys and configuration${NC}"
  fi
else
  echo -e "${GREEN}✓ .env file exists${NC}"
fi

# Step 5: Build frontend
if [ "$SKIP_BUILD" = false ]; then
  echo -e "\n${YELLOW}[5/8] Building frontend...${NC}"
  cd client
  echo "Running npm build..."
  npm run build
  cd ..
  echo -e "${GREEN}✓ Frontend built${NC}"
else
  echo -e "\n${YELLOW}[5/8] Skipping frontend build${NC}"
fi

# Step 5b: Set permissions so web server can read client/build (avoids 403 Forbidden)
echo -e "\n${YELLOW}[5b] Setting permissions on client/build...${NC}"
if [ -d "client/build" ]; then
  chmod -R o+rX client/build
  echo -e "${GREEN}✓ client/build is readable by web server${NC}"
else
  echo -e "${YELLOW}⚠ client/build not found (skip build?). Run a full deploy to create it.${NC}"
fi

# Step 6: Initialize/update database
echo -e "\n${YELLOW}[6/8] Initializing database...${NC}"
# The database will be initialized when the server starts
# But we can run the init script if needed
echo -e "${GREEN}✓ Database will be initialized on server start${NC}"

# Step 7: Set up PM2 or systemd service
echo -e "\n${YELLOW}[7/8] Setting up process management...${NC}"

if [ "$USE_PM2" = true ]; then
  # Create PM2 ecosystem file
  cat > ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: 'markmate',
    script: './server/index.js',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    max_memory_restart: '1G',
    watch: false
  }]
};
EOF

  # Create logs directory
  mkdir -p logs

  # Stop existing PM2 process if running
  pm2 stop markmate 2>/dev/null || true
  pm2 delete markmate 2>/dev/null || true

  # Start with PM2
  pm2 start ecosystem.config.js
  pm2 save

  echo -e "${GREEN}✓ PM2 process started${NC}"
  echo "  View logs: pm2 logs markmate"
  echo "  View status: pm2 status"
else
  echo -e "${YELLOW}⚠ PM2 not available. You'll need to run the server manually:${NC}"
  echo "  NODE_ENV=production node server/index.js"
fi

# Step 8: Configure web server (Virtualmin/Apache)
echo -e "\n${YELLOW}[8/8] Web server configuration...${NC}"
echo -e "${YELLOW}⚠ Manual configuration required for Virtualmin${NC}"
echo ""
echo "Please configure your Virtualmin domain with the following:"
echo ""
echo "1. MarkMate will be served at: https://your-domain.com/tools"
echo "2. Add to Apache VirtualHost configuration:"
echo "   (In Virtualmin: Server Configuration > Apache Configuration)"
echo ""
cat << APACHE_CONFIG
   # Serve MarkMate React app at /tools
   Alias /tools $DEPLOY_DIR/client/build
   
   <Directory "$DEPLOY_DIR/client/build">
     Options -Indexes +FollowSymLinks
     AllowOverride All
     Require all granted
     
     # React Router support
     RewriteEngine On
     RewriteBase /tools/
     RewriteRule ^index\.html$ - [L]
     RewriteCond %{REQUEST_FILENAME} !-f
     RewriteCond %{REQUEST_FILENAME} !-d
     RewriteRule . /tools/index.html [L]
   </Directory>
   
   # Proxy API requests to Node.js backend at /tools/api
   ProxyPreserveHost On
   ProxyPass /tools/api http://localhost:3001/api
   ProxyPassReverse /tools/api http://localhost:3001/api
APACHE_CONFIG

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Deployment Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Next steps:"
echo "1. Configure Virtualmin Apache settings as shown above"
echo "2. Ensure port 3001 is accessible (or change PORT in .env)"
echo "3. Set up SSL certificate in Virtualmin (Let's Encrypt)"
echo "4. Update .env file with your API keys"
echo "5. Test the application at https://$DOMAIN/tools"
echo ""
if [ "$USE_PM2" = true ]; then
  echo "PM2 Commands:"
  echo "  pm2 status          - Check app status"
  echo "  pm2 logs markmate  - View logs"
  echo "  pm2 restart markmate - Restart app"
  echo "  pm2 stop markmate   - Stop app"
fi
echo ""
echo "If you get 403 Forbidden:"
echo "  1. Ensure the Apache <Directory> block above is in your VirtualHost (Require all granted)."
echo "  2. Run: chmod -R o+rX $DEPLOY_DIR/client/build"
echo "  3. On Virtualmin, ensure the domain's document root or the Alias path exists and is readable."
echo "  4. If using SELinux (CentOS/RHEL): setsebool -P httpd_read_user_content 1"
echo "     or: chcon -R -t httpd_sys_content_t $DEPLOY_DIR/client/build"
echo ""
