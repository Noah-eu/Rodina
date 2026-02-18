const request = require('supertest')
const app = require('../src/testServer')

function uniq(prefix = 'u') {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
}

describe('Backend feature integration', () => {
  test('registrace a login vynucuji 4znakový PIN', async () => {
    const badName = uniq('badpin')
    const regBad = await request(app)
      .post('/api/register')
      .field('name', badName)
      .field('pin', '123')

    expect(regBad.statusCode).toBe(400)

    const goodName = uniq('goodpin')
    const regGood = await request(app)
      .post('/api/register')
      .field('name', goodName)
      .field('pin', '1234')

    expect(regGood.statusCode).toBe(200)
    expect(regGood.body.id).toBeTruthy()

    const loginBad = await request(app)
      .post('/api/login')
      .send({ id: regGood.body.id, pin: '12' })

    expect(loginBad.statusCode).toBe(400)
  })

  test('nový uživatel: registrace jménem + další login jen PINem přes id', async () => {
    const name = uniq('flow')
    const pin = '4321'

    const reg = await request(app)
      .post('/api/register')
      .field('name', name)
      .field('pin', pin)

    expect(reg.statusCode).toBe(200)
    expect(reg.body.name).toBe(name)

    const loginByName = await request(app)
      .post('/api/login')
      .send({ name, pin })

    expect(loginByName.statusCode).toBe(200)
    expect(loginByName.body.id).toBe(reg.body.id)

    const loginByIdOnly = await request(app)
      .post('/api/login')
      .send({ id: reg.body.id, pin })

    expect(loginByIdOnly.statusCode).toBe(200)
    expect(loginByIdOnly.body.id).toBe(reg.body.id)
  })

  test('profilová fotka se uloží a je dostupná', async () => {
    const name = uniq('avatar')

    const reg = await request(app)
      .post('/api/register')
      .field('name', name)
      .field('pin', '9876')
      .attach('avatar', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
        filename: 'avatar.jpg',
        contentType: 'image/jpeg'
      })

    expect(reg.statusCode).toBe(200)
    expect(reg.body.avatar).toMatch(/^\/uploads\//)

    const avatarGet = await request(app).get(reg.body.avatar)
    expect(avatarGet.statusCode).toBe(200)
    expect(avatarGet.body.length).toBeGreaterThan(0)

    const users = await request(app).get('/api/users')
    expect(users.statusCode).toBe(200)
    const created = users.body.find((u) => u.id === reg.body.id)
    expect(created).toBeTruthy()
    expect(created.avatar).toBe(reg.body.avatar)
  })

  test('zprávy: text s emoji, fotka a hlasová zpráva', async () => {
    const from = uniq('from')
    const to = uniq('to')

    const regFrom = await request(app)
      .post('/api/register')
      .field('name', from)
      .field('pin', '1111')
    const regTo = await request(app)
      .post('/api/register')
      .field('name', to)
      .field('pin', '2222')

    expect(regFrom.statusCode).toBe(200)
    expect(regTo.statusCode).toBe(200)

    const textRes = await request(app)
      .post('/api/message')
      .send({ from: regFrom.body.id, to: regTo.body.id, text: 'Ahoj 😊❤️', type: 'text' })

    expect(textRes.statusCode).toBe(200)
    expect(textRes.body.type).toBe('text')
    expect(textRes.body.text).toContain('😊')

    const imageRes = await request(app)
      .post('/api/message')
      .field('from', regFrom.body.id)
      .field('to', regTo.body.id)
      .field('text', 'foto')
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        filename: 'photo.png',
        contentType: 'image/png'
      })

    expect(imageRes.statusCode).toBe(200)
    expect(imageRes.body.type).toBe('image')
    expect(imageRes.body.url).toMatch(/^\/uploads\//)

    const audioRes = await request(app)
      .post('/api/message')
      .field('from', regFrom.body.id)
      .field('to', regTo.body.id)
      .attach('file', Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), {
        filename: 'voice.webm',
        contentType: 'audio/webm'
      })

    expect(audioRes.statusCode).toBe(200)
    expect(audioRes.body.type).toBe('audio')
    expect(audioRes.body.url).toMatch(/^\/uploads\//)

    const list = await request(app)
      .get('/api/messages')
      .query({ me: regFrom.body.id, peer: regTo.body.id, limit: 50 })

    expect(list.statusCode).toBe(200)
    expect(Array.isArray(list.body)).toBe(true)
    expect(list.body.some(m => m.type === 'text' && m.text.includes('😊'))).toBe(true)
    expect(list.body.some(m => m.type === 'image')).toBe(true)
    expect(list.body.some(m => m.type === 'audio')).toBe(true)
  })

  test('videotelefonní signaling endpointy odpovídají OK', async () => {
    const payload = { from: 'alice', to: 'bob', kind: 'video', sdp: 'mock-sdp' }

    const endpoints = [
      '/api/rt/offer',
      '/api/rt/answer',
      '/api/rt/ice',
      '/api/rt/accept',
      '/api/rt/decline',
      '/api/rt/hangup',
      '/api/call'
    ]

    for (const endpoint of endpoints) {
      const res = await request(app).post(endpoint).send(payload)
      expect(res.statusCode).toBe(200)
      expect(res.body.ok).toBe(true)
    }
  })
})
