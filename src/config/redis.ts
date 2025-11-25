import Redis from 'ioredis'

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL is not defined in environment variables')
}

const redis = new Redis(process.env.REDIS_URL)

const get_new_redis_client = (url?: string) => {
  if (url) {
    return new Redis(url)
  }
  return new Redis(process.env.REDIS_URL as string)
}

const redis_ping = async () => {
  try {
    await redis.ping()
    console.log('Connected to Redis successfully')
  } catch (error) {
    console.error('Failed to connect to Redis:', error)
    throw error
  }
}

redis_ping()

export { redis, redis_ping, get_new_redis_client }
