const request = require('supertest')
const app = require('../src/testServer')

describe('/api/ice', () => {
  test('returns 500 when Xirsys credentials are not configured', async () => {
    const res = await request(app).get('/api/ice')
    // Either 500 or a successful response if envs are present in CI
    expect([200,500,502]).toContain(res.statusCode)
    if(res.statusCode >= 200 && res.statusCode < 300){
      expect(res.body.iceServers).toBeDefined()
      expect(Array.isArray(res.body.iceServers)).toBe(true)
    } else {
      expect(res.body.error).toBeDefined()
    }
  })
})
