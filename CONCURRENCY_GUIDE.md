# Concurrency & Load Handling Guide

## Quick Answer

**Express and Elysia do NOT automatically handle multiple worker processes/clustering**. You need to set this up yourself using a process manager like PM2.

## How Node.js/Bun Handle Concurrency

### Current Setup (Single Process)
- ✅ **Asynchronous I/O**: Handles concurrent requests efficiently
- ✅ **Event Loop**: Can handle thousands of concurrent connections
- ❌ **Single Thread**: Limited by one CPU core
- ❌ **No True Parallelism**: CPU-intensive tasks block the event loop

### What Frameworks Provide Automatically
Both Express and Elysia provide:
- ✅ Asynchronous request handling (can handle thousands of concurrent requests)
- ✅ Non-blocking I/O operations
- ❌ **NOT multi-threaded clustering** (you need PM2 or similar)

## Production Recommendations

### Option 1: PM2 (Recommended)
PM2 automatically spawns multiple instances of your app across all CPU cores, providing:
- Load balancing across instances
- Zero-downtime deployments
- Auto-restart on crashes
- Process monitoring

**Setup:**
```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### Option 2: Nginx Reverse Proxy
In production, use Nginx as a reverse proxy in front of your app:
- Load balancing across multiple app instances
- SSL termination
- Rate limiting
- Static file serving

**Example nginx config:**
```nginx
upstream backend {
    server localhost:5000;
    server localhost:5001;
    server localhost:5002;
    server localhost:5003;
}

server {
    listen 80;
    server_name your-domain.com;
    
    location / {
        proxy_pass http://backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Option 3: Docker + Multiple Containers
Deploy multiple container instances behind a load balancer:
```yaml
# docker-compose.yml
services:
  app:
    build: .
    deploy:
      replicas: 4
    ports:
      - "5000-5003:5000"
```

## Why Your Requests Might Be Getting Missed

### If you're NOT getting missed requests:
✅ Your current setup is fine for development and moderate traffic
- Bun/Node.js can handle thousands of concurrent connections
- The event loop efficiently handles async I/O

### If you ARE experiencing issues:

1. **Database Connection Pool Limits**
   - Your DB might be the bottleneck
   - Check your PostgreSQL connection pool settings

2. **Synchronous Blocking Code**
   - Avoid CPU-intensive synchronous operations
   - Use async/await properly

3. **Memory Limitations**
   - Monitor memory usage
   - Implement request queuing if needed

## Monitoring & Scaling

### Check Current Performance
```bash
# Monitor CPU/Memory usage
top
htop

# Check active connections
netstat -an | grep :5000 | wc -l

# Monitor with PM2
pm2 monit
```

### When to Scale
- CPU usage consistently > 80%
- Response time > 500ms for simple requests
- Memory usage approaching limits
- Active connections > 10,000 per instance

## Best Practices

1. **Always use PM2 in production** for multi-core utilization
2. **Use a reverse proxy** (Nginx) for additional load balancing
3. **Monitor your database** - it's often the real bottleneck
4. **Implement rate limiting** to prevent abuse
5. **Use connection pooling** for database connections
6. **Profile your code** to find bottlenecks

## Testing Concurrency

Test with Apache Bench (ab):
```bash
ab -n 10000 -c 1000 http://localhost:5000/api/
```

Or with wrk:
```bash
wrk -t12 -c400 -d30s http://localhost:5000/api/
```

## Summary

✅ **For most apps**: PM2 clustering is sufficient
✅ **For high-traffic apps**: PM2 + Nginx + Multiple servers
✅ **Your current setup**: Works for development, add PM2 for production

**No missed requests** is achieved by:
1. Using PM2 to spawn multiple instances (1 per CPU core)
2. Each instance can handle thousands of concurrent connections
3. Load is distributed across all instances
4. Process restarts automatically on crashes

The framework (Elysia/Express) handles the async concurrency within each instance. PM2 handles the multi-core parallelism across instances.

