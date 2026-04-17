---
name: rate-limiting
description: Implement rate limiting on APIs. Per-IP, per-user, sliding window patterns. Express and framework-agnostic.
type: pattern
tier: library
domains: [security, api, backend]
trigger: "rate limit, throttle, ddos, abuse prevention, too many requests, 429"
---

## Rate Limiting Strategies

### Per-IP (unauthenticated endpoints)
Protects login, registration, password-reset from brute force.

### Per-User (authenticated endpoints)
Fair use — prevents a single user from hammering your API.

### Per-Route (sensitive endpoints)
Extra tight limits on auth, payment, export endpoints.

## Express Implementation (express-rate-limit)

```typescript
import rateLimit from 'express-rate-limit';
import { Redis } from 'ioredis';
import { RedisStore } from 'rate-limit-redis';

const redis = new Redis(process.env.REDIS_URL);

// General API rate limit
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 100,                    // 100 requests per window
  standardHeaders: true,       // Return rate limit info in RateLimit-* headers
  legacyHeaders: false,
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args) }),
  handler: (req, res) => {
    res.status(429).json({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please try again later.',
        retryAfter: Math.ceil(req.rateLimit.resetTime / 1000),
      },
    });
  },
});

// Strict limit for auth endpoints
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,                      // 5 login attempts per 15 minutes
  skipSuccessfulRequests: true, // don't count successful logins
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args) }),
  keyGenerator: (req) => `auth:${req.ip}:${req.body?.email || ''}`,
});

// Usage
app.use('/api', apiLimiter);
app.post('/api/auth/login', authLimiter, loginHandler);
```

## Per-User Limit (After Authentication)

```typescript
export const perUserLimiter = rateLimit({
  windowMs: 60 * 1000,    // 1 minute
  max: 60,                 // 60 requests per minute per user
  keyGenerator: (req) => `user:${req.user?.id || req.ip}`,
});

app.use('/api', authenticate, perUserLimiter);
```

## Sliding Window with Redis (Manual)

```typescript
async function isRateLimited(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;

  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStart);        // remove old entries
  pipeline.zadd(key, now, `${now}`);                     // add current request
  pipeline.zcard(key);                                    // count in window
  pipeline.expire(key, windowSeconds);                   // auto-cleanup

  const results = await pipeline.exec();
  const count = results![2][1] as number;
  return count > limit;
}
```

## Response Headers (Standard)

```
RateLimit-Limit: 100
RateLimit-Remaining: 75
RateLimit-Reset: 1704067200
Retry-After: 300  (only on 429)
```

## Testing Rate Limits

```typescript
it('blocks after limit exceeded', async () => {
  for (let i = 0; i < 5; i++) {
    await request(app).post('/api/auth/login').send(validCreds);
  }
  const response = await request(app).post('/api/auth/login').send(validCreds);
  expect(response.status).toBe(429);
  expect(response.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
});
```
