/**
 * RSS 聚合 Worker（纯 JS）
 */

const FEED_LIST = [
  "https://rsshub.app/github/trending/daily",
  "https://rsshub.app/hackernews/best/comments"
]

const DEFAULT_CACHE_TTL = 3600; // 1 小时
const MAX_CONCURRENT = 5;
const MAX_DYNAMIC_FEEDS = 20;

async function fetchFeed(url) {
  try {
    const res = await fetch(url)
    const text = await res.text()
    const items = [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
      const block = m[1]
      const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || ""
      const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || ""
      const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || ""
      return { source: url, title, link, pubDate }
    })
    return items.filter(i => i.title && i.link)
  } catch (err) {
    console.warn(`⚠️ Failed to fetch ${url}: ${err}`)
    return []
  }
}

async function aggregateFeeds(feeds) {
  const results = []
  for (let i = 0; i < feeds.length; i += MAX_CONCURRENT) {
    const chunk = feeds.slice(i, i + MAX_CONCURRENT)
    const chunkResults = await Promise.all(chunk.map(fetchFeed))
    results.push(...chunkResults.flat())
  }
  return results.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
}

function paginate(items, page = 1, pageSize = 20) {
  const start = (page - 1) * pageSize
  return items.slice(start, start + pageSize)
}

export default {
  async scheduled(event, env, ctx) {
    const data = await aggregateFeeds(FEED_LIST)
    await env.CACHE.put("aggregated:fixed", JSON.stringify({
      lastUpdate: new Date().toISOString(),
      feeds: FEED_LIST,
      items: data
    }), { expirationTtl: DEFAULT_CACHE_TTL })
    console.log("✅ Fixed feeds updated")
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const feedsParam = url.searchParams.get("feeds")
    const page = parseInt(url.searchParams.get("page") || "1")
    const pageSize = parseInt(url.searchParams.get("pageSize") || "20")
    const cacheTtl = parseInt(url.searchParams.get("ttl") || DEFAULT_CACHE_TTL)

    let cacheKey = "aggregated:fixed"
    let feedsToUse = FEED_LIST

    if (feedsParam) {
      feedsToUse = feedsParam.split(",").map(u => u.trim()).filter(Boolean)
      if (feedsToUse.length > MAX_DYNAMIC_FEEDS) feedsToUse = feedsToUse.slice(0, MAX_DYNAMIC_FEEDS)
      cacheKey = "aggregated:dynamic:" + feedsToUse.join("|")
    }

    const cached = await env.CACHE.get(cacheKey)
    if (cached) {
      const payload = JSON.parse(cached)
      payload.items = paginate(payload.items, page, pageSize)
      return new Response(JSON.stringify(payload, null, 2), {
        headers: { "Content-Type": "application/json" }
      })
    }

    const data = await aggregateFeeds(feedsToUse)
    const payload = {
      lastUpdate: new Date().toISOString(),
      feeds: feedsToUse,
      items: paginate(data, page, pageSize)
    }
    await env.CACHE.put(cacheKey, JSON.stringify(payload, null, 2), { expirationTtl: cacheTtl })

    return new Response(JSON.stringify(payload, null, 2), {
      headers: { "Content-Type": "application/json" }
    })
  }
}
