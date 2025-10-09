# 🍪 Cookie Authentication Debug Guide

## The Root Cause

**Cross-subdomain cookies** (from `api.amigochats.com` to `www.amigochats.com`) require the `domain` attribute to be set to `.amigochats.com` (with leading dot).

## What Was Fixed

### 1. Added Environment-Based Cookie Domain Configuration
```typescript
// At the top of auth.routes.ts
const COOKIE_DOMAIN = process.env.NODE_ENV === "production" ? ".amigochats.com" : undefined;
```

### 2. Updated All Cookie Operations
- **Signup** (verify-signup-otp)
- **Login** (verify-login-otp & verify-email-login)
- **Refresh** (/auth/refresh)
- **Logout** (/auth/logout)

All now use:
```typescript
cookie["refresh_token"].set({
  value: token,
  httpOnly: true,
  secure: true,
  sameSite: "none",
  maxAge: 60 * 60 * 24 * 7,
  path: "/",
  ...(COOKIE_DOMAIN && { domain: COOKIE_DOMAIN }),  // ✅ Dynamic domain
});
```

## Why This Works

### Localhost (NODE_ENV !== "production")
- `COOKIE_DOMAIN = undefined`
- Cookies work without domain attribute (same-origin)
- Browser handles it automatically

### Production (NODE_ENV === "production")
- `COOKIE_DOMAIN = ".amigochats.com"`
- Cookies are accessible across:
  - `api.amigochats.com` ✅
  - `www.amigochats.com` ✅
  - Any subdomain of `amigochats.com` ✅

## Testing Steps

### 1. Set Environment Variable
Make sure your production backend has:
```bash
NODE_ENV=production
```

### 2. Deploy the Changes
```bash
cd ~/workspace/amigo/amigo-backend
# Deploy your backend (however you do it)
```

### 3. Test Login Flow
1. Go to `https://www.amigochats.com/login`
2. Open DevTools → Network tab
3. Enter credentials and login
4. Check the response headers for `Set-Cookie`:
   ```
   Set-Cookie: refresh_token=...; Domain=.amigochats.com; Path=/; HttpOnly; Secure; SameSite=None
   Set-Cookie: access_token=...; Domain=.amigochats.com; Path=/; HttpOnly; Secure; SameSite=None
   ```

### 4. Check Browser Storage
After login:
1. Open DevTools → Application → Cookies
2. Check for cookies under `.amigochats.com`
3. You should see:
   - `refresh_token` (HttpOnly ✅, Secure ✅, SameSite=None ✅, Domain=.amigochats.com ✅)
   - `access_token` (HttpOnly ✅, Secure ✅, SameSite=None ✅, Domain=.amigochats.com ✅)

### 5. Test Navigation
- Navigate to `/dashboard`
- Refresh the page
- Cookies should persist ✅

### 6. Test Token Refresh
1. Manually delete `access_token` cookie
2. Make an API request (it will fail with 401)
3. Frontend auto-calls `/auth/refresh`
4. Check that new cookies are set with correct domain
5. Page should reload and work ✅

### 7. Test Logout
1. Click logout
2. Check that cookies are cleared
3. Should redirect to `/login` ✅

## Server Logs to Watch

You'll now see detailed logs:

```bash
[LOGIN] Attempt from origin: https://www.amigochats.com | Cookie domain: .amigochats.com
[LOGIN] ✅ Success! Set cookies with domain: .amigochats.com | User: admin@example.com
```

## Common Issues & Solutions

### Issue 1: "Cookies not being set"
**Check:**
- Is `NODE_ENV=production` set?
- Are you using HTTPS? (Required for `secure: true`)
- Is CORS properly configured?

**Solution:**
```bash
# Check environment
echo $NODE_ENV

# Should output: production
```

### Issue 2: "Cookies set but not sent with requests"
**Check:**
- Domain attribute matches your actual domain
- Frontend is using `credentials: "include"`

**Solution:**
Verify in `api-client.ts`:
```typescript
credentials: "include",  // ✅ This is already set
```

### Issue 3: "Works in localhost but not production"
This was the exact issue! Now fixed with dynamic domain.

### Issue 4: "Cookies visible but middleware says 'not authenticated'"
**Check:**
- Middleware is reading the correct cookie names
- Tokens are valid and not expired

**Solution:**
Check middleware.ts and ensure it's looking for `refresh_token` cookie.

## Why HttpOnly Cookies Are Worth It

Despite being "annoying", httpOnly cookies provide:

1. **XSS Protection** - JavaScript can't access tokens
2. **Automatic Sending** - Browser handles it
3. **Secure Storage** - Not in localStorage
4. **Standard Pattern** - Used by major services

The tradeoff is dealing with CORS and domain configuration, which we've now properly handled.

## Quick Reference

| Setting | Value | Purpose |
|---------|-------|---------|
| `httpOnly` | `true` | Prevents JavaScript access (XSS protection) |
| `secure` | `true` | HTTPS only |
| `sameSite` | `"none"` | Allows cross-site requests |
| `path` | `"/"` | Accessible from all routes |
| `domain` | `".amigochats.com"` | Works across subdomains |
| `maxAge` | `60*60*24*7` | 7 days for refresh, 1 day for access |

## Need More Help?

Check the server logs for the detailed output. If cookies still aren't working:

1. Verify `NODE_ENV` is set in production
2. Check browser DevTools → Network → Response Headers
3. Look for any CORS errors in browser console
4. Ensure backend and frontend URLs are correct

