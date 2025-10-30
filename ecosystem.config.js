/**
 * PM2 Ecosystem Configuration
 * 
 * PM2 is a production process manager that provides:
 * - Zero-downtime deployments
 * - Automatic load balancing across multiple CPU cores
 * - Process monitoring and auto-restart on crashes
 * - Log management
 * 
 * To use this configuration:
 * 1. Install PM2 globally: npm install -g pm2
 * 2. Start your app: pm2 start ecosystem.config.js
 * 3. Save the process list: pm2 save
 * 4. Setup startup script: pm2 startup
 * 
 * Management commands:
 * - pm2 status: View running processes
 * - pm2 logs: View logs
 * - pm2 restart all: Restart all processes
 * - pm2 stop all: Stop all processes
 * - pm2 delete all: Remove all processes
 */

module.exports = {
  apps: [{
    name: 'amigo-backend',
    script: './src/server.ts',
    instances: 'max', // Automatically spawn one instance per CPU core
    exec_mode: 'cluster', // Enable load balancing across instances
    interpreter: 'bun',
    
    // Auto restart on file changes during development
    watch: process.env.NODE_ENV === 'development',
    ignore_watch: ['node_modules', 'drizzle', '.git'],
    
    // Environment variables
    env: {
      NODE_ENV: 'production',
      CLUSTER_MODE: 'true',
    },
    
    // Restart settings
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    
    // Logging
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    
    // Memory management
    max_memory_restart: '1G', // Restart if memory exceeds 1GB
    
    // Kill settings
    kill_timeout: 5000,
    wait_ready: true,
    
    // Health monitoring
    listen_timeout: 10000,
  }]
};

